import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../configuration/env.js';
import { AppError } from '../errors/app-error.js';

export interface AccessTokenClaims {
  /** User id. Kept as `id` for compatibility with existing clients. */
  id: string;
  sub: string;
  username: string;
  organizationId: string | null;
  sessionId: string;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    return jwt.verify(token, env.JWT_SECRET) as AccessTokenClaims;
  } catch (error) {
    const expired = error instanceof jwt.TokenExpiredError;
    throw new AppError(401, expired ? 'Session expired' : 'Invalid authentication token', {
      code: 'authentication_error',
      details: { expired },
    });
  }
}

/**
 * Refresh tokens and password-reset tokens are opaque random strings; only
 * their hash is stored, so a database leak cannot be replayed.
 */
export function generateOpaqueToken(): string {
  return randomBytes(48).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
