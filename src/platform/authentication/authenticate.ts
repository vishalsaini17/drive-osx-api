import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { enrichContext } from '../../infrastructure/observability/logger.js';
import { AppError } from '../errors/app-error.js';
import { verifyAccessToken } from './tokens.js';

export interface AuthenticatedUser {
  id: string;
  username: string;
  organizationId: string | null;
  sessionId: string;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

function readBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim() || null;
  }
  // Signed download links and EventSource cannot set headers.
  const queryToken = req.query.access_token;
  return typeof queryToken === 'string' && queryToken.length > 0 ? queryToken : null;
}

function attach(req: Request, token: string): void {
  const claims = verifyAccessToken(token);
  req.user = {
    id: claims.id ?? claims.sub,
    username: claims.username,
    organizationId: claims.organizationId ?? null,
    sessionId: claims.sessionId,
  };
  enrichContext({
    userId: req.user.id,
    ...(req.user.organizationId ? { organizationId: req.user.organizationId } : {}),
  });
}

/** Rejects the request unless a valid access token is present. */
export function authenticate(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = readBearerToken(req);
    if (!token) {
      next(AppError.authentication('Authentication token missing'));
      return;
    }

    try {
      attach(req, token);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Attaches identity when present but never rejects — for public+personalised routes. */
export function optionalAuthentication(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = readBearerToken(req);
    if (!token) {
      next();
      return;
    }

    try {
      attach(req, token);
    } catch {
      // An invalid token on an optional route is treated as anonymous.
    }
    next();
  };
}

/** Narrows the Express request once `authenticate()` has run. */
export function requireUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw AppError.authentication();
  }
  return req.user;
}

/**
 * Tenant scope for the request. Every tenant-scoped query is filtered by this
 * value — it is never taken from the request body (CLAUDE.md §15, §17).
 */
export function requireOrganization(req: Request): { user: AuthenticatedUser; organizationId: string } {
  const user = requireUser(req);
  const headerOrganization = req.headers['x-organization-id'];
  const organizationId =
    (typeof headerOrganization === 'string' && headerOrganization) || user.organizationId;

  if (!organizationId) {
    throw AppError.validation('No active organization for this session');
  }

  return { user, organizationId };
}
