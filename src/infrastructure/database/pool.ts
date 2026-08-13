import pg from 'pg';
import { env } from '../../platform/configuration/env.js';
import { AppError } from '../../platform/errors/app-error.js';
import { logger, rootLogger } from '../observability/logger.js';

const { Pool } = pg;

export type QueryParam = unknown;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (error) => {
  rootLogger.error({ err: error }, 'idle postgres client error');
});

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: QueryParam[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * Executes a statement on the shared pool. Slow statements are logged so a
 * degrading query is visible before it becomes an outage.
 */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<pg.QueryResult<R>> {
  const startedAt = process.hrtime.bigint();
  try {
    return await pool.query<R>(text, params as never[]);
  } finally {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (durationMs > 500) {
      logger().warn({ durationMs, sql: text.slice(0, 200) }, 'slow query');
    }
  }
}

export async function queryOne<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<R | null> {
  const result = await query<R>(text, params);
  return result.rows[0] ?? null;
}

export async function queryMany<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<R[]> {
  const result = await query<R>(text, params);
  return result.rows;
}

/**
 * Runs `fn` inside a transaction. Multi-step domain operations (create file +
 * first version + audit entry + outbox event) must be atomic.
 */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyDatabaseConnection(): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw AppError.dependency('Database is unreachable', error);
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

/** Postgres unique-violation, surfaced as a domain conflict by callers. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

export function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23503';
}
