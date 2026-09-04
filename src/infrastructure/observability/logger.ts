import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';
import { env, isProduction } from '../../platform/configuration/env.js';

export interface RequestContext {
  requestId: string;
  userId?: string;
  organizationId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const rootLogger: Logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'drive-osx-api', env: env.NODE_ENV },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'token',
      '*.token',
      'refreshToken',
      '*.refreshToken',
    ],
    censor: '[redacted]',
  },
  ...(isProduction ? {} : { transport: { target: 'pino/file', options: { destination: 1 } } }),
});

/** Logger bound to the current request/job context, so every line is traceable. */
export function logger(): Logger {
  const context = storage.getStore();
  return context ? rootLogger.child(context) : rootLogger;
}

export function runWithContext<T>(context: Partial<RequestContext>, fn: () => T): T {
  const existing = storage.getStore();
  return storage.run(
    { requestId: context.requestId ?? existing?.requestId ?? randomUUID(), ...existing, ...context },
    fn,
  );
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Enriches the active context once identity is known (after authentication). */
export function enrichContext(patch: Partial<RequestContext>): void {
  const context = storage.getStore();
  if (!context) return;
  Object.assign(context, patch);
}
