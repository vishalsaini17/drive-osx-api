import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, pool } from './pool.js';
import { rootLogger } from '../observability/logger.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

interface AppliedMigration {
  name: string;
  checksum: string;
}

/**
 * Forward-only SQL migrations, applied in filename order inside a single
 * transaction each. Checksums are verified so an already-applied file cannot be
 * edited silently — a schema change must be a new file (CLAUDE.md §50.19).
 */
export async function runMigrations(): Promise<{ applied: string[] }> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

  const { rows } = await pool.query<AppliedMigration>('SELECT name, checksum FROM schema_migrations');
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));
  const newlyApplied: string[] = [];

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(file);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration "${file}" has changed since it was applied. ` +
            'Applied migrations are immutable — add a new migration instead.',
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
      await client.query('COMMIT');
      newlyApplied.push(file);
      rootLogger.info({ migration: file }, 'migration applied');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Migration "${file}" failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }

  if (newlyApplied.length === 0) {
    rootLogger.info('database schema is up to date');
  }

  return { applied: newlyApplied };
}

// Allow `npm run migrate` as a standalone command (used by the container entrypoint).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  runMigrations()
    .then(async () => {
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (error) => {
      rootLogger.fatal({ err: error }, 'migration run failed');
      await closeDatabase().catch(() => undefined);
      process.exit(1);
    });
}
