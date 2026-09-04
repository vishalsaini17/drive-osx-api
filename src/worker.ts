import { createServer, type Server } from 'node:http';
import { env } from './platform/configuration/env.js';
import { closeDatabase, verifyDatabaseConnection } from './infrastructure/database/pool.js';
import { closeRedis, verifyRedisConnection } from './infrastructure/redis/client.js';
import { objectStorage } from './infrastructure/storage/s3-object-storage.js';
import {
  queueStats,
  recoverOrphanedJobs,
  startQueueWorker,
  type QueueWorker,
} from './infrastructure/queue/queue.js';
import { dispatchPendingEvents, eventBacklog, logRegisteredHandlers } from './platform/events/event-bus.js';
import { rootLogger } from './infrastructure/observability/logger.js';
import { registerWorkHandlers } from './workers/handlers.js';

/**
 * Background worker process: dispatches the domain-event outbox and consumes
 * the job queue. It runs separately from the API so slow work can never block a
 * user request, and so the two can be scaled independently (CLAUDE.md §23).
 */
async function start(): Promise<void> {
  await verifyDatabaseConnection();
  await verifyRedisConnection();
  await objectStorage.ensureReady();

  registerWorkHandlers();
  logRegisteredHandlers();

  await recoverOrphanedJobs();
  const queueWorker = startQueueWorker(env.WORKER_CONCURRENCY);

  let running = true;

  const outboxLoop = (async () => {
    while (running) {
      try {
        const dispatched = await dispatchPendingEvents();
        // Only idle when there was nothing to do — otherwise drain at full speed.
        if (dispatched === 0) {
          await sleep(env.WORKER_POLL_INTERVAL_MS);
        }
      } catch (error) {
        rootLogger.error({ err: error }, 'event dispatch loop failed; retrying');
        await sleep(env.WORKER_POLL_INTERVAL_MS * 5);
      }
    }
  })();

  const healthServer = startHealthServer();

  rootLogger.info(
    { concurrency: env.WORKER_CONCURRENCY, healthPort: env.WORKER_HEALTH_PORT },
    'drive-osx-worker started',
  );

  registerShutdown(async () => {
    running = false;
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await queueWorker.stop();
    await outboxLoop;
  });
}

/**
 * A background process with no listening socket cannot be health-checked by an
 * orchestrator. This exposes just enough to answer "is it alive, and is it
 * keeping up?" — queue depth and event backlog included, so a stuck worker is
 * visible rather than merely running.
 */
function startHealthServer(): Server {
  const server = createServer((request, response) => {
    if (request.url !== '/health' && request.url !== '/health/ready') {
      response.writeHead(404).end();
      return;
    }

    Promise.all([queueStats(), eventBacklog()])
      .then(([queue, events]) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            status: 'ok',
            service: 'drive-osx-worker',
            uptimeSeconds: Math.round(process.uptime()),
            queue,
            events,
          }),
        );
      })
      .catch((error: Error) => {
        // Redis or PostgreSQL is unreachable: the worker cannot do its job.
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'degraded', error: error.message }));
      });
  });

  server.listen(env.WORKER_HEALTH_PORT);
  return server;
}

function registerShutdown(stop: () => Promise<void>): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    rootLogger.info({ signal }, 'worker shutting down');

    // Let in-flight jobs finish; unfinished ones return to the queue.
    await Promise.race([stop(), sleep(15_000)]);
    await Promise.allSettled([closeDatabase(), closeRedis()]);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    rootLogger.error({ err: reason }, 'unhandled promise rejection in worker');
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { QueueWorker };

start().catch((error) => {
  rootLogger.fatal({ err: error }, 'failed to start drive-osx-worker');
  process.exit(1);
});
