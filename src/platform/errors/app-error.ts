/**
 * Error taxonomy for the platform. Every failure that reaches a client is
 * classified so the UI can decide whether to retry, re-authenticate, queue the
 * operation offline, or show a validation message next to a field.
 *
 * See CLAUDE.md §36 — errors must be explicit and actionable.
 */
export const ErrorCode = {
  VALIDATION: 'validation_error',
  AUTHENTICATION: 'authentication_error',
  PERMISSION: 'permission_error',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  QUOTA_EXCEEDED: 'quota_exceeded',
  RATE_LIMITED: 'rate_limited',
  STORAGE: 'storage_error',
  DEPENDENCY: 'dependency_error',
  INTERNAL: 'internal_error',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AppErrorOptions {
  /** Machine readable classification the client switches on. */
  code?: ErrorCodeValue;
  /** Field-level or contextual detail. Never include secrets. */
  details?: unknown;
  /** Whether the same request may succeed if retried unchanged. */
  retryable?: boolean;
  /** Underlying error, kept for logs only — never serialised to clients. */
  cause?: unknown;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(statusCode: number, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = options.code ?? inferCode(statusCode);
    this.details = options.details ?? null;
    this.retryable = options.retryable ?? statusCode >= 500;
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError(400, message, { code: ErrorCode.VALIDATION, details });
  }

  static authentication(message = 'Authentication required'): AppError {
    return new AppError(401, message, { code: ErrorCode.AUTHENTICATION });
  }

  static permission(message = 'You do not have access to this resource'): AppError {
    return new AppError(403, message, { code: ErrorCode.PERMISSION });
  }

  static notFound(message = 'Resource not found'): AppError {
    return new AppError(404, message, { code: ErrorCode.NOT_FOUND });
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError(409, message, { code: ErrorCode.CONFLICT, details });
  }

  static quota(message: string, details?: unknown): AppError {
    return new AppError(413, message, { code: ErrorCode.QUOTA_EXCEEDED, details });
  }

  static rateLimited(message = 'Too many requests', details?: unknown): AppError {
    return new AppError(429, message, { code: ErrorCode.RATE_LIMITED, details, retryable: true });
  }

  static storage(message: string, cause?: unknown): AppError {
    return new AppError(502, message, { code: ErrorCode.STORAGE, cause, retryable: true });
  }

  static dependency(message: string, cause?: unknown): AppError {
    return new AppError(503, message, { code: ErrorCode.DEPENDENCY, cause, retryable: true });
  }

  static internal(message = 'Internal server error', cause?: unknown): AppError {
    return new AppError(500, message, { code: ErrorCode.INTERNAL, cause });
  }
}

function inferCode(statusCode: number): ErrorCodeValue {
  switch (statusCode) {
    case 400:
      return ErrorCode.VALIDATION;
    case 401:
      return ErrorCode.AUTHENTICATION;
    case 403:
      return ErrorCode.PERMISSION;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 413:
      return ErrorCode.QUOTA_EXCEEDED;
    case 429:
      return ErrorCode.RATE_LIMITED;
    default:
      return statusCode >= 500 ? ErrorCode.INTERNAL : ErrorCode.VALIDATION;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
