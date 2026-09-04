import { query, queryOne, type Queryable } from '../../infrastructure/database/pool.js';
import type { SessionRow, UserRow } from './identity.types.js';

const USER_COLUMNS = `
  id, username, email, first_name, last_name, full_name, recovery_email, mobile,
  password_hash, avatar_url, status, primary_organization_id, current_organization_id,
  mfa_enabled, last_login_at, created_at, updated_at
`;

export interface CreateUserInput {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  recoveryEmail: string | null;
  mobile: string | null;
  passwordHash: string;
}

export async function insertUser(tx: Queryable, input: CreateUserInput): Promise<UserRow> {
  const { rows } = await tx.query<UserRow>(
    `INSERT INTO users (username, email, first_name, last_name, full_name, recovery_email, mobile, password_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${USER_COLUMNS}`,
    [
      input.username,
      input.email,
      input.firstName,
      input.lastName,
      input.fullName,
      input.recoveryEmail,
      input.mobile,
      input.passwordHash,
    ],
  );
  return rows[0]!;
}

export function findUserById(userId: string): Promise<UserRow | null> {
  return queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND status <> 'deleted'`, [userId]);
}

export function findUserByUsername(username: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE username = lower($1) AND status <> 'deleted'`,
    [username],
  );
}

export function findUserByEmail(email: string): Promise<UserRow | null> {
  return queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE email = lower($1) AND status <> 'deleted'`, [
    email,
  ]);
}

/** Used by password recovery and member invitations, which accept any identifier. */
export function findUserByAnyIdentifier(identifier: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `SELECT ${USER_COLUMNS}
       FROM users
      WHERE status <> 'deleted'
        AND (username = lower($1) OR email = lower($1) OR recovery_email = lower($1))
      ORDER BY (username = lower($1)) DESC
      LIMIT 1`,
    [identifier],
  );
}

export async function updateUserPassword(userId: string, passwordHash: string): Promise<void> {
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
}

export async function setCurrentOrganization(
  tx: Queryable,
  userId: string,
  organizationId: string,
  alsoPrimary = false,
): Promise<void> {
  await tx.query(
    `UPDATE users
        SET current_organization_id = $2,
            primary_organization_id = CASE WHEN $3 OR primary_organization_id IS NULL THEN $2 ELSE primary_organization_id END
      WHERE id = $1`,
    [userId, organizationId, alsoPrimary],
  );
}

export async function recordLogin(userId: string): Promise<void> {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}

export async function updateUserProfile(
  userId: string,
  patch: { firstName?: string; lastName?: string; recoveryEmail?: string | null; mobile?: string | null; avatarUrl?: string | null },
): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `UPDATE users
        SET first_name = coalesce($2, first_name),
            last_name = coalesce($3, last_name),
            full_name = coalesce($2, first_name) || ' ' || coalesce($3, last_name),
            recovery_email = coalesce($4, recovery_email),
            mobile = coalesce($5, mobile),
            avatar_url = coalesce($6, avatar_url)
      WHERE id = $1
      RETURNING ${USER_COLUMNS}`,
    [
      userId,
      patch.firstName ?? null,
      patch.lastName ?? null,
      patch.recoveryEmail ?? null,
      patch.mobile ?? null,
      patch.avatarUrl ?? null,
    ],
  );
}

// ---------------------------------------------------------------- sessions

export interface CreateSessionInput {
  userId: string;
  organizationId: string | null;
  refreshTokenHash: string;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
}

export async function insertSession(tx: Queryable, input: CreateSessionInput): Promise<SessionRow> {
  const { rows } = await tx.query<SessionRow>(
    `INSERT INTO sessions (user_id, organization_id, refresh_token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, organization_id, expires_at, revoked_at`,
    [input.userId, input.organizationId, input.refreshTokenHash, input.expiresAt, input.userAgent, input.ipAddress],
  );
  return rows[0]!;
}

export function findActiveSessionByRefreshHash(hash: string): Promise<SessionRow | null> {
  return queryOne<SessionRow>(
    `SELECT id, user_id, organization_id, expires_at, revoked_at
       FROM sessions
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hash],
  );
}

export async function rotateSession(sessionId: string, refreshTokenHash: string, expiresAt: Date): Promise<void> {
  await query(
    'UPDATE sessions SET refresh_token_hash = $2, expires_at = $3, last_used_at = now() WHERE id = $1',
    [sessionId, refreshTokenHash, expiresAt],
  );
}

export async function revokeSession(sessionId: string): Promise<void> {
  await query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

// --------------------------------------------------- password reset tokens

export async function insertPasswordResetToken(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
    userId,
    tokenHash,
    expiresAt,
  ]);
}

export function findValidPasswordResetToken(tokenHash: string): Promise<{ id: string; user_id: string } | null> {
  return queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id
       FROM password_reset_tokens
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
}

export async function consumePasswordResetToken(id: string): Promise<void> {
  await query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [id]);
}
