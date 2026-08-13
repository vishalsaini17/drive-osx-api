import { Redis } from 'ioredis';
import { env } from '../../platform/configuration/env.js';
import { rootLogger } from '../observability/logger.js';

/**
 * Redis holds cache, ephemeral realtime state (presence, typing), rate-limit
 * counters and the job queue. Nothing here is a source of truth — every value
 * must be rebuildable from PostgreSQL (CLAUDE.md §12).
 */
function createClient(role: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Connect on first use rather than on import, so loading a module for its
    // domain logic (tests, CLI tasks) does not open a socket. Boot still fails
    // fast: verifyRedisConnection() issues a PING during startup.
    lazyConnect: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  client.on('error', (error) => {
    rootLogger.error({ err: error, role }, 'redis connection error');
  });

  return client;
}

export const redis = createClient('primary');

/** Separate connection: a client in subscriber mode cannot issue commands. */
let subscriberClient: Redis | null = null;

export function subscriber(): Redis {
  if (!subscriberClient) {
    subscriberClient = createClient('subscriber');
  }
  return subscriberClient;
}

/** Blocking queue reads must not occupy the shared command connection. */
let blockingClient: Redis | null = null;

export function blockingConnection(): Redis {
  if (!blockingClient) {
    blockingClient = createClient('blocking');
  }
  return blockingClient;
}

export async function verifyRedisConnection(): Promise<void> {
  await redis.ping();
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([
    redis.quit(),
    subscriberClient?.quit(),
    blockingClient?.quit(),
  ]);
}
