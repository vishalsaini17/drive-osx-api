import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Configuration is validated once, at boot. A misconfigured deployment should
 * fail immediately and loudly rather than at the first request that needs the
 * missing value.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(7000),
  API_VERSION: z.string().default('v1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // PostgreSQL — system of record.
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Redis — cache, ephemeral realtime state, queues.
  REDIS_URL: z.string().min(1),

  // S3-compatible object storage — file bytes.
  STORAGE_ENDPOINT: z.string().min(1),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_BUCKET: z.string().default('drive-osx'),
  STORAGE_ACCESS_KEY: z.string().min(1),
  STORAGE_SECRET_KEY: z.string().min(1),
  STORAGE_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  STORAGE_PUBLIC_URL: z.string().optional(),

  // Authentication.
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  ACCESS_TOKEN_TTL: z.string().default('1h'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(15),

  // HTTP.
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:5173,http://127.0.0.1:3000,http://127.0.0.1:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(300),

  // Platform behaviour.
  MAIL_DOMAIN: z.string().default('driveosx.com'),
  /**
   * Shared secret proving a request to the inbound-mail endpoint came from the
   * SMTP gateway. That endpoint cannot carry a user session — inbound mail has
   * no logged-in actor — so without this secret anyone who can reach the API
   * can deliver a message into any mailbox with a forged sender.
   *
   * Required in production; `load()` refuses to boot without it.
   */
  MAIL_GATEWAY_TOKEN: z.string().optional(),
  /**
   * Base URL of drive-osx-mail's outbound relay (POST /deliver), used to hand
   * off queued outbound mail for real SMTP delivery. Presents
   * MAIL_GATEWAY_TOKEN the same way inbound delivery does, just in reverse.
   */
  MAIL_GATEWAY_URL: z.string().default('http://localhost:2526'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  INLINE_CONTENT_MAX_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  DEFAULT_STORAGE_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 1024 * 1024 * 1024),

  // Worker.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  /** Liveness endpoint for the background process, so it can be health-checked. */
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(7001),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const value = parsed.data;

  // A missing gateway secret leaves inbound mail open to anyone who can reach
  // the API. That is a deployment mistake, not a runtime condition, so it is
  // caught at boot rather than on the first delivery.
  if (value.NODE_ENV === 'production' && !value.MAIL_GATEWAY_TOKEN) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  - MAIL_GATEWAY_TOKEN: required in production. Without it, POST /mail/receive\n' +
        '    accepts unauthenticated deliveries with an attacker-chosen sender.\n' +
        '    Generate one with: openssl rand -hex 32',
    );
  }

  return value;
}

export const env: Env = load();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const apiBasePath = `/api/${env.API_VERSION}`;
