import { Router, type Request, type Response } from 'express';
import { asyncHandler } from './async-handler.js';
import { env } from '../configuration/env.js';
import { pool } from '../../infrastructure/database/pool.js';
import { redis } from '../../infrastructure/redis/client.js';
import { queueStats } from '../../infrastructure/queue/queue.js';
import { eventBacklog } from '../events/event-bus.js';

export const healthRoutes = Router();

/**
 * Liveness: the process is up. Kept dependency-free so a database blip does not
 * cause the orchestrator to restart a healthy API.
 */
healthRoutes.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'drive-osx-api', version: env.API_VERSION, uptime: process.uptime() });
});

/** Readiness: the process can actually serve traffic. */
healthRoutes.get(
  '/health/ready',
  asyncHandler(async (_req: Request, res: Response) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    await Promise.all([
      pool
        .query('SELECT 1')
        .then(() => {
          checks.database = { ok: true };
        })
        .catch((error: Error) => {
          checks.database = { ok: false, detail: error.message };
        }),
      redis
        .ping()
        .then(() => {
          checks.redis = { ok: true };
        })
        .catch((error: Error) => {
          checks.redis = { ok: false, detail: error.message };
        }),
    ]);

    const ready = Object.values(checks).every((check) => check.ok);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', checks });
  }),
);

/** Operational detail for dashboards: queue depth and event backlog. */
healthRoutes.get(
  '/health/metrics',
  asyncHandler(async (_req: Request, res: Response) => {
    const [queue, events] = await Promise.all([
      queueStats().catch(() => null),
      eventBacklog().catch(() => null),
    ]);

    res.json({
      uptimeSeconds: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      queue,
      events,
    });
  }),
);
