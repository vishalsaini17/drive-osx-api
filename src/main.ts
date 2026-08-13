import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './platform/configuration/env.js';
import { closeDatabase, verifyDatabaseConnection } from './infrastructure/database/pool.js';
import { runMigrations } from './infrastructure/database/migrate.js';
import { closeRedis, verifyRedisConnection } from './infrastructure/redis/client.js';
import { objectStorage } from './infrastructure/storage/s3-object-storage.js';
import { createRealtimeServer } from './infrastructure/realtime/signaling.js';
import { rootLogger } from './infrastructure/observability/logger.js';

async function start(): Promise<Server> {
  // Fail fast: a half-connected API is worse than one that refuses to boot.
  await verifyDatabaseConnection();
  await verifyRedisConnection();
  await objectStorage.ensureReady();
  await runMigrations();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    rootLogger.info({ port: env.PORT, env: env.NODE_ENV }, 'drive-osx-api listening');
  });

  createRealtimeServer(server);
  registerShutdown(server);

  return server;
}

function registerShutdown(server: Server): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    rootLogger.info({ signal }, 'shutting down');

    // Stop accepting new work, then release connections.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
    await Promise.race([closed, timeout]);

    await Promise.allSettled([closeDatabase(), closeRedis()]);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    rootLogger.error({ err: reason }, 'unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    rootLogger.fatal({ err: error }, 'uncaught exception, exiting');
    process.exit(1);
  });
}

start().catch((error) => {
  rootLogger.fatal({ err: error }, 'failed to start drive-osx-api');
  process.exit(1);
});
