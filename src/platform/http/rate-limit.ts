import type { RequestHandler } from 'express';
import { env } from '../configuration/env.js';
import { redis } from '../../infrastructure/redis/client.js';
import { logger } from '../../infrastructure/observability/logger.js';
import { AppError } from '../errors/app-error.js';

export interface RateLimitOptions {
  /** Distinguishes independent buckets (e.g. "login" vs "api"). */
  bucket: string;
  windowSeconds?: number;
  max?: number;
}

/**
 * Fixed-window limiter backed by Redis. If Redis is unavailable the request is
 * allowed through — availability of the platform outweighs precise limiting,
 * and the failure is logged rather than swallowed.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const windowSeconds = options.windowSeconds ?? env.RATE_LIMIT_WINDOW_SECONDS;
  const max = options.max ?? env.RATE_LIMIT_MAX_REQUESTS;

  return (req, res, next) => {
    const identity = req.user?.id ?? req.ip ?? 'anonymous';
    const windowStart = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `ratelimit:${options.bucket}:${identity}:${windowStart}`;

    redis
      .multi()
      .incr(key)
      .expire(key, windowSeconds)
      .exec()
      .then((results) => {
        const count = Number(results?.[0]?.[1] ?? 0);
        res.setHeader('X-RateLimit-Limit', max);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));

        if (count > max) {
          const retryAfter = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
          res.setHeader('Retry-After', retryAfter);
          next(
            AppError.rateLimited('Too many requests. Please wait before trying again.', {
              retryAfterSeconds: retryAfter,
            }),
          );
          return;
        }

        next();
      })
      .catch((error) => {
        logger().warn({ err: error, bucket: options.bucket }, 'rate limiter unavailable, allowing request');
        next();
      });
  };
}
