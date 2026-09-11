import { randomUUID } from 'node:crypto';
import { env } from '../../platform/configuration/env.js';
import { blockingConnection, redis } from '../redis/client.js';
import { logger, rootLogger, runWithContext } from '../observability/logger.js';

/**
 * Minimal Redis-backed job queue. Long-running work (thumbnails, search
 * indexing, mail delivery, exports) must never block an API request
 * (CLAUDE.md §23). A dedicated broker is deliberately not introduced yet —
 * see CLAUDE.md §46.
 *
 * Delivery is at-least-once: handlers must be idempotent.
 */
export type JobName =
  | 'file.thumbnail'
  | 'file.index'
  | 'file.purge'
  | 'mail.deliver'
  | 'mail.register-sender'
  | 'notification.dispatch'
  | 'audit.write';

export interface Job<T = unknown> {
  id: string;
  name: JobName;
  payload: T;
  attempts: number;
  maxAttempts: number;
  enqueuedAt: string;
  requestId?: string;
}

export type JobHandler<T = any> = (payload: T, job: Job<T>) => Promise<void>;

const QUEUE_KEY = 'queue:jobs';
const PROCESSING_KEY = 'queue:jobs:processing';
const DELAYED_KEY = 'queue:jobs:delayed';
const DEAD_LETTER_KEY = 'queue:jobs:dead';

export interface EnqueueOptions {
  maxAttempts?: number;
  delaySeconds?: number;
  requestId?: string;
}

export async function enqueue<T>(name: JobName, payload: T, options: EnqueueOptions = {}): Promise<string> {
  const job: Job<T> = {
    id: randomUUID(),
    name,
    payload,
    attempts: 0,
    maxAttempts: options.maxAttempts ?? 5,
    enqueuedAt: new Date().toISOString(),
    ...(options.requestId ? { requestId: options.requestId } : {}),
  };

  const serialised = JSON.stringify(job);

  if (options.delaySeconds && options.delaySeconds > 0) {
    await redis.zadd(DELAYED_KEY, Date.now() + options.delaySeconds * 1000, serialised);
  } else {
    await redis.lpush(QUEUE_KEY, serialised);
  }

  logger().debug({ jobId: job.id, job: name }, 'job enqueued');
  return job.id;
}

const handlers = new Map<JobName, JobHandler>();

export function registerJobHandler<T>(name: JobName, handler: JobHandler<T>): void {
  if (handlers.has(name)) {
    throw new Error(`Job handler already registered for "${name}"`);
  }
  handlers.set(name, handler as JobHandler);
}

/** Moves due delayed jobs onto the ready queue. */
async function promoteDelayedJobs(): Promise<void> {
  const due = await redis.zrangebyscore(DELAYED_KEY, 0, Date.now(), 'LIMIT', 0, 50);
  for (const serialised of due) {
    const removed = await redis.zrem(DELAYED_KEY, serialised);
    if (removed > 0) {
      await redis.lpush(QUEUE_KEY, serialised);
    }
  }
}

async function runJob(serialised: string): Promise<void> {
  let job: Job;
  try {
    job = JSON.parse(serialised) as Job;
  } catch (error) {
    rootLogger.error({ err: error }, 'discarding unparseable job payload');
    await redis.lrem(PROCESSING_KEY, 1, serialised);
    return;
  }

  const handler = handlers.get(job.name);
  if (!handler) {
    rootLogger.error({ job: job.name, jobId: job.id }, 'no handler registered for job');
    await redis.lrem(PROCESSING_KEY, 1, serialised);
    await redis.lpush(DEAD_LETTER_KEY, serialised);
    return;
  }

  await runWithContext({ requestId: job.requestId ?? job.id }, async () => {
    try {
      await handler(job.payload, job);
      logger().debug({ jobId: job.id, job: job.name }, 'job completed');
    } catch (error) {
      const attempts = job.attempts + 1;
      if (attempts >= job.maxAttempts) {
        logger().error(
          { err: error, jobId: job.id, job: job.name, attempts },
          'job failed permanently, moved to dead letter queue',
        );
        await redis.lpush(DEAD_LETTER_KEY, JSON.stringify({ ...job, attempts, failedAt: new Date().toISOString() }));
      } else {
        // Exponential backoff: 2s, 4s, 8s, 16s…
        const delayMs = 2 ** attempts * 1000;
        logger().warn({ err: error, jobId: job.id, job: job.name, attempts, delayMs }, 'job failed, retrying');
        await redis.zadd(DELAYED_KEY, Date.now() + delayMs, JSON.stringify({ ...job, attempts }));
      }
    } finally {
      await redis.lrem(PROCESSING_KEY, 1, serialised);
    }
  });
}

export interface QueueWorker {
  stop(): Promise<void>;
}

/** Starts `concurrency` consumer loops. Returns a handle for graceful shutdown. */
export function startQueueWorker(concurrency = env.WORKER_CONCURRENCY): QueueWorker {
  let running = true;
  const connection = blockingConnection();

  const loops = Array.from({ length: concurrency }, async () => {
    while (running) {
      try {
        const serialised = await connection.brpoplpush(QUEUE_KEY, PROCESSING_KEY, 1);
        if (serialised) {
          await runJob(serialised);
        }
      } catch (error) {
        if (!running) break;
        rootLogger.error({ err: error }, 'queue consumer error');
        await sleep(1000);
      }
    }
  });

  const promoter = (async () => {
    while (running) {
      try {
        await promoteDelayedJobs();
      } catch (error) {
        rootLogger.error({ err: error }, 'failed to promote delayed jobs');
      }
      await sleep(env.WORKER_POLL_INTERVAL_MS);
    }
  })();

  rootLogger.info({ concurrency, handlers: [...handlers.keys()] }, 'queue worker started');

  return {
    async stop() {
      running = false;
      await Promise.allSettled([...loops, promoter]);
    },
  };
}

/** Jobs left in `processing` by a crashed worker are returned to the queue. */
export async function recoverOrphanedJobs(): Promise<number> {
  let recovered = 0;
  for (;;) {
    const serialised = await redis.rpoplpush(PROCESSING_KEY, QUEUE_KEY);
    if (!serialised) break;
    recovered += 1;
    if (recovered > 10_000) break;
  }
  if (recovered > 0) {
    rootLogger.warn({ recovered }, 'recovered orphaned jobs from a previous worker run');
  }
  return recovered;
}

export async function queueStats(): Promise<{ ready: number; processing: number; delayed: number; dead: number }> {
  const [ready, processing, delayed, dead] = await Promise.all([
    redis.llen(QUEUE_KEY),
    redis.llen(PROCESSING_KEY),
    redis.zcard(DELAYED_KEY),
    redis.llen(DEAD_LETTER_KEY),
  ]);
  return { ready, processing, delayed, dead };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
