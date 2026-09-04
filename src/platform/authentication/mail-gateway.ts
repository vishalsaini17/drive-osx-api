import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env, isProduction } from '../configuration/env.js';
import { logger } from '../../infrastructure/observability/logger.js';
import { AppError } from '../errors/app-error.js';

/**
 * Trust boundary for inbound mail.
 *
 * Delivery cannot present a user session — an incoming message has no
 * logged-in actor — so the SMTP gateway proves itself with a shared secret
 * instead. Without this, the delivery endpoint accepts a message with any
 * `from` address from anyone who can open a socket to the API, which is a
 * ready-made phishing channel.
 */
export const MAIL_GATEWAY_HEADER = 'x-mail-gateway-token';

/** Constant-time comparison; a length mismatch is a mismatch, not a shortcut. */
export function tokenMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!expected || !presented) return false;

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  // timingSafeEqual throws on unequal lengths, which would itself leak length.
  // Comparing digests of equal size keeps the comparison constant-time.
  if (a.length !== b.length) {
    // Still burn a comparison so the rejection path costs the same.
    timingSafeEqual(b, b);
    return false;
  }

  return timingSafeEqual(a, b);
}

/**
 * Decides an inbound delivery. Separated from the middleware so the policy —
 * including the development-mode escape hatch — is directly testable.
 */
export function evaluateGatewayRequest(input: {
  presented: string | undefined;
  expected: string | undefined;
  production: boolean;
}): { allowed: boolean; reason: 'ok' | 'unconfigured-development' | 'missing-token' | 'bad-token' } {
  if (!input.expected) {
    // Boot already refuses this in production; in development we allow it so a
    // fresh checkout can receive mail, but the caller logs a warning.
    return input.production
      ? { allowed: false, reason: 'missing-token' }
      : { allowed: true, reason: 'unconfigured-development' };
  }

  if (!input.presented) return { allowed: false, reason: 'missing-token' };

  return tokenMatches(input.presented, input.expected)
    ? { allowed: true, reason: 'ok' }
    : { allowed: false, reason: 'bad-token' };
}

let warnedAboutMissingToken = false;

/** Rejects any inbound delivery that cannot prove it came from the gateway. */
export function requireMailGateway(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const presented = req.headers[MAIL_GATEWAY_HEADER];

    const decision = evaluateGatewayRequest({
      presented: typeof presented === 'string' ? presented : undefined,
      expected: env.MAIL_GATEWAY_TOKEN,
      production: isProduction,
    });

    if (decision.reason === 'unconfigured-development' && !warnedAboutMissingToken) {
      warnedAboutMissingToken = true;
      logger().warn(
        'MAIL_GATEWAY_TOKEN is not set: inbound mail delivery is unauthenticated. ' +
          'Set it in drive-osx-api/.env and drive-osx-mail/.env before exposing this API.',
      );
    }

    if (!decision.allowed) {
      logger().warn({ reason: decision.reason, ip: req.ip }, 'rejected inbound mail delivery');
      next(AppError.authentication('Inbound mail delivery requires a valid gateway token'));
      return;
    }

    next();
  };
}
