import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { runWithContext } from '../../infrastructure/observability/logger.js';
import type { AuthenticatedUser } from '../authentication/authenticate.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      requestId?: string;
    }
  }
}

/**
 * Assigns a request id and binds it to the async context so every log line,
 * domain event and background job started by this request is traceable
 * end to end (CLAUDE.md §29).
 */
export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers['x-request-id'] as string | undefined) || randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    runWithContext({ requestId }, () => next());
  };
}
