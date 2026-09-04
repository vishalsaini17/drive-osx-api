import type { Request } from 'express';
import type { ZodError, ZodTypeAny, output } from 'zod';
import { AppError } from '../errors/app-error.js';

export interface FieldIssue {
  field: string;
  message: string;
}

function toFieldIssues(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    message: issue.message,
  }));
}

/**
 * Validation failures return field-level detail so the UI can put the message
 * next to the input that caused it rather than in a generic toast
 * (CLAUDE.md §20, §36).
 *
 * The return type is the schema's *output*, so defaults and transforms are
 * reflected in what callers receive.
 */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown, label = 'Request'): output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw AppError.validation(`${label} is invalid`, { fields: toFieldIssues(result.error) });
  }
  return result.data as output<S>;
}

export function parseBody<S extends ZodTypeAny>(schema: S, req: Request): output<S> {
  return parse(schema, req.body ?? {}, 'Request body');
}

export function parseQuery<S extends ZodTypeAny>(schema: S, req: Request): output<S> {
  return parse(schema, req.query ?? {}, 'Query string');
}

export function parseParams<S extends ZodTypeAny>(schema: S, req: Request): output<S> {
  return parse(schema, req.params ?? {}, 'Path parameters');
}
