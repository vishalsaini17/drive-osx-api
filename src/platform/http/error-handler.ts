import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../configuration/env.js';
import { logger } from '../../infrastructure/observability/logger.js';
import { AppError, ErrorCode, isAppError } from '../errors/app-error.js';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details: unknown;
    retryable: boolean;
    requestId?: string;
  };
  /** Legacy flat field kept for existing clients. */
  message: string;
}

export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(AppError.notFound(`No route matches ${req.method} ${req.path}`));
  };
}

/**
 * Single place where an error becomes an HTTP response. Client errors carry
 * their message through; server errors are logged with full context and
 * answered with a generic message so internals never leak (CLAUDE.md §29).
 */
export function errorHandler(): ErrorRequestHandler {
  return (error, req, res, _next) => {
    const appError = normalise(error);

    if (appError.statusCode >= 500) {
      logger().error(
        { err: error, path: req.path, method: req.method, statusCode: appError.statusCode },
        'request failed',
      );
    } else {
      logger().info(
        { path: req.path, method: req.method, statusCode: appError.statusCode, code: appError.code },
        appError.message,
      );
    }

    const body: ErrorBody = {
      error: {
        code: appError.code,
        message: appError.message,
        details: appError.details,
        retryable: appError.retryable,
        ...(req.requestId ? { requestId: req.requestId } : {}),
      },
      message: appError.message,
    };

    if (res.headersSent) {
      res.end();
      return;
    }

    res.status(appError.statusCode).json(body);
  };
}

function normalise(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof ZodError) {
    return AppError.validation('Request is invalid', {
      fields: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    });
  }

  // Body parser and multer surface their own status codes.
  const candidate = error as { status?: number; statusCode?: number; message?: string; code?: string };
  const status = candidate?.status ?? candidate?.statusCode;

  if (candidate?.code === 'LIMIT_FILE_SIZE') {
    return AppError.quota('The uploaded file exceeds the maximum allowed size');
  }

  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new AppError(status, candidate.message ?? 'Request rejected', { code: ErrorCode.VALIDATION });
  }

  return new AppError(500, isProduction ? 'Internal server error' : String(candidate?.message ?? error), {
    code: ErrorCode.INTERNAL,
    cause: error,
  });
}
