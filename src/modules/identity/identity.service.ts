import { env } from '../../platform/configuration/env.js';
import { AppError } from '../../platform/errors/app-error.js';
import { publishEvent } from '../../platform/events/event-bus.js';
import {
  comparePassword,
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  signAccessToken,
} from '../../platform/authentication/tokens.js';
import { isUniqueViolation, withTransaction } from '../../infrastructure/database/pool.js';
import { logger } from '../../infrastructure/observability/logger.js';
import { cacheDelete, cacheKeys } from '../../infrastructure/redis/cache.js';
import { recordAudit, recordAuditDetached } from '../audit/audit.service.js';
import { createOrganizationInTransaction, reserveSlug } from '../organizations/organizations.service.js';
import * as repository from './identity.repository.js';
import { toUserView, type AuthResult, type UserRow, type UserView } from './identity.types.js';

export interface RegisterInput {
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  recoveryEmail?: string | undefined;
  mobile?: string | undefined;
}

export interface RequestMetadata {
  ipAddress?: string | null;
  userAgent?: string | null;
}

function accessTokenTtlSeconds(): number {
  const match = /^(\d+)([smhd])$/.exec(env.ACCESS_TOKEN_TTL);
  if (!match) return 3600;
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86_400;
  return amount * multiplier;
}

async function issueSession(
  user: UserRow,
  organizationId: string | null,
  metadata: RequestMetadata,
): Promise<AuthResult> {
  const refreshToken = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  const session = await withTransaction((tx) =>
    repository.insertSession(tx, {
      userId: user.id,
      organizationId,
      refreshTokenHash: hashOpaqueToken(refreshToken),
      expiresAt,
      userAgent: metadata.userAgent ?? null,
      ipAddress: metadata.ipAddress ?? null,
    }),
  );

  const token = signAccessToken({
    id: user.id,
    sub: user.id,
    username: user.username,
    organizationId,
    sessionId: session.id,
  });

  return {
    token,
    refreshToken,
    expiresIn: accessTokenTtlSeconds(),
    user: { ...toUserView(user), organizationId },
  };
}

/**
 * Registration provisions the whole tenant: user, personal workspace, owner
 * membership and the default drive folders — all in one transaction.
 */
export async function register(input: RegisterInput, metadata: RequestMetadata = {}): Promise<{ user: UserView }> {
  const username = input.username.trim().toLowerCase();

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw AppError.validation(
      'Username must be 3–32 characters and may contain letters, numbers, dots, dashes and underscores',
    );
  }

  const existing = await repository.findUserByUsername(username);
  if (existing) {
    throw AppError.conflict('That username is already taken');
  }

  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const fullName = `${firstName} ${lastName}`.trim();
  const email = `${username}@${env.MAIL_DOMAIN}`;
  const passwordHash = await hashPassword(input.password);
  const slug = await reserveSlug(`${username}-workspace`);

  try {
    const user = await withTransaction(async (tx) => {
      const created = await repository.insertUser(tx, {
        username,
        email,
        firstName,
        lastName,
        fullName,
        recoveryEmail: input.recoveryEmail?.trim().toLowerCase() || null,
        mobile: input.mobile?.trim() || null,
        passwordHash,
      });

      const organization = await createOrganizationInTransaction(tx, created.id, {
        name: `${fullName}'s Workspace`,
        type: 'personal',
        slug,
      });

      await recordAudit(tx, {
        organizationId: organization.id,
        actorId: created.id,
        action: 'user.registered',
        resourceType: 'user',
        resourceId: created.id,
        metadata: { username },
        ipAddress: metadata.ipAddress ?? null,
        userAgent: metadata.userAgent ?? null,
      });

      await publishEvent(
        tx,
        'user.registered',
        { userId: created.id, organizationId: organization.id, username },
        { organizationId: organization.id, actorId: created.id },
      );

      return { ...created, current_organization_id: organization.id, primary_organization_id: organization.id };
    });

    return { user: toUserView(user) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict('That username or email is already taken');
    }
    throw error;
  }
}

export async function login(
  input: { username: string; password: string },
  metadata: RequestMetadata = {},
): Promise<AuthResult> {
  const user = await repository.findUserByUsername(input.username.trim().toLowerCase());

  // Same response for unknown user and wrong password: no account enumeration.
  if (!user || !(await comparePassword(input.password, user.password_hash))) {
    recordAuditDetached({
      organizationId: null,
      actorId: user?.id ?? null,
      action: 'auth.login_failed',
      resourceType: 'user',
      resourceId: user?.id ?? null,
      metadata: { username: input.username },
      ipAddress: metadata.ipAddress ?? null,
      userAgent: metadata.userAgent ?? null,
    });
    throw AppError.authentication('Incorrect username or password');
  }

  if (user.status !== 'active') {
    throw AppError.permission('This account has been suspended. Contact your workspace administrator.');
  }

  const organizationId = user.current_organization_id ?? user.primary_organization_id;
  const result = await issueSession(user, organizationId, metadata);

  await repository.recordLogin(user.id);
  recordAuditDetached({
    organizationId,
    actorId: user.id,
    action: 'auth.login',
    resourceType: 'user',
    resourceId: user.id,
    ipAddress: metadata.ipAddress ?? null,
    userAgent: metadata.userAgent ?? null,
  });

  return result;
}

export async function refresh(refreshToken: string, metadata: RequestMetadata = {}): Promise<AuthResult> {
  const session = await repository.findActiveSessionByRefreshHash(hashOpaqueToken(refreshToken));
  if (!session) {
    throw AppError.authentication('Your session has expired. Please sign in again.');
  }

  const user = await repository.findUserById(session.user_id);
  if (!user || user.status !== 'active') {
    await repository.revokeSession(session.id);
    throw AppError.authentication('Your session is no longer valid');
  }

  // Rotate on every use so a stolen refresh token has a single-use lifetime.
  const nextRefreshToken = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await repository.rotateSession(session.id, hashOpaqueToken(nextRefreshToken), expiresAt);

  const organizationId = user.current_organization_id ?? session.organization_id;
  const token = signAccessToken({
    id: user.id,
    sub: user.id,
    username: user.username,
    organizationId,
    sessionId: session.id,
  });

  return {
    token,
    refreshToken: nextRefreshToken,
    expiresIn: accessTokenTtlSeconds(),
    user: { ...toUserView(user), organizationId },
  };
}

export async function logout(sessionId: string, userId: string): Promise<void> {
  await repository.revokeSession(sessionId);
  await cacheDelete(cacheKeys.userProfile(userId));
  recordAuditDetached({
    organizationId: null,
    actorId: userId,
    action: 'auth.logout',
    resourceType: 'session',
    resourceId: sessionId,
  });
}

export async function getProfile(userId: string): Promise<UserView> {
  const user = await repository.findUserById(userId);
  if (!user) throw AppError.notFound('User not found');
  return toUserView(user);
}

export async function updateProfile(
  userId: string,
  patch: { firstName?: string; lastName?: string; recoveryEmail?: string; mobile?: string; avatarUrl?: string },
): Promise<UserView> {
  const updated = await repository.updateUserProfile(userId, patch);
  if (!updated) throw AppError.notFound('User not found');
  await cacheDelete(cacheKeys.userProfile(userId));
  return toUserView(updated);
}

/**
 * Credential check for the SMTP gateway. Returns the mailbox identity only —
 * no token is issued, so a mail session cannot act on the HTTP API.
 */
export async function authenticateForMail(input: {
  username: string;
  password: string;
}): Promise<{ id: string; username: string; fullName: string; email: string; organizationId: string | null }> {
  const user = await repository.findUserByUsername(input.username.trim().toLowerCase());
  if (!user || !(await comparePassword(input.password, user.password_hash))) {
    throw AppError.authentication('Incorrect username or password');
  }

  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    email: user.email,
    organizationId: user.current_organization_id ?? user.primary_organization_id,
  };
}

export interface ForgotPasswordResult {
  message: string;
  /** Returned only outside production, where no mail transport is configured. */
  resetToken?: string;
}

export async function forgotPassword(identifier: string): Promise<ForgotPasswordResult> {
  const user = await repository.findUserByAnyIdentifier(identifier.trim().toLowerCase());
  const message = 'If an account matches that identifier, a password reset link has been sent.';

  // Always the same answer, so this endpoint cannot be used to probe accounts.
  if (!user) {
    logger().info({ identifier }, 'password reset requested for unknown identifier');
    return { message };
  }

  const token = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000);
  await repository.insertPasswordResetToken(user.id, hashOpaqueToken(token), expiresAt);

  recordAuditDetached({
    organizationId: user.current_organization_id,
    actorId: user.id,
    action: 'auth.password_reset_requested',
    resourceType: 'user',
    resourceId: user.id,
  });

  return env.NODE_ENV === 'production' ? { message } : { message, resetToken: token };
}

export async function resetPassword(token: string, password: string): Promise<{ message: string }> {
  const record = await repository.findValidPasswordResetToken(hashOpaqueToken(token));
  if (!record) {
    throw AppError.validation('This password reset link is invalid or has expired. Request a new one.');
  }

  const passwordHash = await hashPassword(password);
  await repository.updateUserPassword(record.user_id, passwordHash);
  await repository.consumePasswordResetToken(record.id);
  // Any session opened with the old password is no longer trusted.
  await repository.revokeAllUserSessions(record.user_id);

  recordAuditDetached({
    organizationId: null,
    actorId: record.user_id,
    action: 'auth.password_reset',
    resourceType: 'user',
    resourceId: record.user_id,
  });

  return { message: 'Your password has been reset. Please sign in with your new password.' };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ message: string }> {
  const user = await repository.findUserById(userId);
  if (!user) throw AppError.notFound('User not found');

  if (!(await comparePassword(currentPassword, user.password_hash))) {
    throw AppError.validation('Your current password is incorrect');
  }

  await repository.updateUserPassword(userId, await hashPassword(newPassword));
  await repository.revokeAllUserSessions(userId);

  recordAuditDetached({
    organizationId: user.current_organization_id,
    actorId: userId,
    action: 'auth.password_changed',
    resourceType: 'user',
    resourceId: userId,
  });

  return { message: 'Password changed. Please sign in again on your other devices.' };
}
