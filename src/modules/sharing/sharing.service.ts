import { randomUUID } from 'node:crypto';
import { AppError } from '../../platform/errors/app-error.js';
import { publishEvent } from '../../platform/events/event-bus.js';
import { requireFileAccess } from '../../platform/authorization/access-control.js';
import type { ResourceRole } from '../../platform/authorization/roles.js';
import { generateOpaqueToken, hashOpaqueToken } from '../../platform/authentication/tokens.js';
import { isUniqueViolation, query, queryMany, queryOne, withTransaction } from '../../infrastructure/database/pool.js';
import { recordAudit } from '../audit/audit.service.js';
import { findFileById, findFileByIdUnscoped } from '../files/files.repository.js';
import { toFileView, type FileView } from '../files/files.types.js';
import { findOrganizationById } from '../organizations/organizations.repository.js';
import { findUserByAnyIdentifier, findUserById } from '../identity/identity.repository.js';
import { toOrganizationView, type OrganizationSettings } from '../organizations/organizations.types.js';
import { listAuditLogs } from '../audit/audit.service.js';

export interface ShareView {
  id: string;
  fileId: string;
  principalType: 'user' | 'team' | 'organization' | 'link';
  principalId: string | null;
  principalName: string | null;
  /** Only set for `principalType === 'user'`; teams/links have no @handle. */
  principalUsername: string | null;
  role: ResourceRole;
  message: string | null;
  expiresAt: string | null;
  createdAt: string;
  sharedBy: string;
}

interface ShareRow {
  id: string;
  file_id: string;
  principal_type: ShareView['principalType'];
  principal_id: string | null;
  principal_name: string | null;
  principal_username: string | null;
  role: ResourceRole;
  message: string | null;
  expires_at: Date | null;
  created_at: Date;
  shared_by: string;
}

export function toShareView(row: ShareRow): ShareView {
  return {
    id: row.id,
    fileId: row.file_id,
    principalType: row.principal_type,
    principalId: row.principal_id,
    principalName: row.principal_name,
    principalUsername: row.principal_username,
    role: row.role,
    message: row.message,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    sharedBy: row.shared_by,
  };
}

const SHARE_SELECT = `
  SELECT s.id, s.file_id, s.principal_type, s.principal_id, s.role, s.message,
         s.expires_at, s.created_at, s.shared_by,
         COALESCE(u.full_name, t.name) AS principal_name,
         u.username AS principal_username
    FROM shares s
    LEFT JOIN users u ON s.principal_type = 'user' AND u.id = s.principal_id
    LEFT JOIN teams t ON s.principal_type = 'team' AND t.id = s.principal_id
`;

export interface Actor {
  userId: string;
  organizationId: string;
}

/**
 * Pure policy decision, split out from `assertSharingAllowed` so it can be
 * unit tested without a database. Only link shares can leave the tenant
 * (CLAUDE.md §17); direct user/team shares stay within the app's existing
 * contacts-based eligibility check instead.
 */
export function isSharingAllowed(
  settings: Pick<OrganizationSettings, 'allowExternalSharing' | 'sharingPolicy'>,
  principalType: ShareView['principalType'],
): { allowed: boolean; message?: string } {
  if (principalType !== 'link') return { allowed: true };
  if (settings.allowExternalSharing) return { allowed: true };
  if (settings.sharingPolicy.mode === 'restrict') {
    return { allowed: false, message: settings.sharingPolicy.warningMessage };
  }
  return { allowed: true };
}

/**
 * The workspace sharing policy decides whether a share may leave the tenant
 * (CLAUDE.md §17). Policy lives with the organization; enforcement lives here.
 */
async function assertSharingAllowed(
  organizationId: string,
  principalType: ShareView['principalType'],
): Promise<void> {
  if (principalType !== 'link') return;

  const organization = await findOrganizationById(organizationId);
  if (!organization) throw AppError.notFound('Workspace not found');

  const settings = toOrganizationView(organization).settings;
  const decision = isSharingAllowed(settings, principalType);
  if (!decision.allowed) {
    throw AppError.permission(decision.message ?? 'Sharing is restricted in this workspace');
  }
}

export interface ShareWithUserInput {
  fileId: string;
  /** Preferred when the caller already resolved a specific person (e.g. an eligible-users suggestion). */
  userId?: string;
  usernameOrEmail?: string;
  role: ResourceRole;
  message?: string;
  expiresAt?: string;
}

export async function shareWithUser(actor: Actor, input: ShareWithUserInput): Promise<ShareView> {
  const file = await findFileById(actor.organizationId, input.fileId);
  if (!file) throw AppError.notFound('File not found');

  // Only someone who owns the file may hand out access to it.
  await requireFileAccess(actor.userId, subjectOf(file), 'owner');

  const target = input.userId
    ? await findUserById(input.userId)
    : input.usernameOrEmail
      ? await findUserByAnyIdentifier(input.usernameOrEmail)
      : null;
  if (!target) {
    throw AppError.notFound(`No user found for "${input.userId ?? input.usernameOrEmail ?? ''}"`);
  }
  if (target.id === file.owner_id) {
    throw AppError.validation('This person already owns the file');
  }

  const share = await withTransaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO shares (organization_id, file_id, shared_by, principal_type, principal_id, role, message, expires_at)
       VALUES ($1, $2, $3, 'user', $4, $5, $6, $7)
       ON CONFLICT (file_id, principal_type, principal_id) WHERE revoked_at IS NULL AND principal_type IN ('user','team')
       DO UPDATE SET role = EXCLUDED.role, message = EXCLUDED.message, expires_at = EXCLUDED.expires_at
       RETURNING id`,
      [
        actor.organizationId,
        input.fileId,
        actor.userId,
        target.id,
        input.role,
        input.message ?? null,
        input.expiresAt ? new Date(input.expiresAt) : null,
      ],
    );

    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'file.shared',
      resourceType: 'file',
      resourceId: input.fileId,
      metadata: { principalType: 'user', principalId: target.id, role: input.role },
    });

    await publishEvent(
      tx,
      'file.shared',
      {
        organizationId: actor.organizationId,
        fileId: input.fileId,
        actorId: actor.userId,
        principalType: 'user',
        principalId: target.id,
        role: input.role,
      },
      { organizationId: actor.organizationId, actorId: actor.userId },
    );

    return rows[0]!;
  });

  const view = await queryOne<ShareRow>(`${SHARE_SELECT} WHERE s.id = $1`, [share.id]);
  if (!view) throw AppError.internal('Share was created but could not be read back');
  return toShareView(view);
}

export async function shareWithTeam(
  actor: Actor,
  input: { fileId: string; teamId: string; role: ResourceRole },
): Promise<ShareView> {
  const file = await findFileById(actor.organizationId, input.fileId);
  if (!file) throw AppError.notFound('File not found');
  await requireFileAccess(actor.userId, subjectOf(file), 'owner');

  const team = await queryOne<{ id: string }>('SELECT id FROM teams WHERE id = $1 AND organization_id = $2', [
    input.teamId,
    actor.organizationId,
  ]);
  if (!team) throw AppError.notFound('Team not found');

  const { rows } = await query<{ id: string }>(
    `INSERT INTO shares (organization_id, file_id, shared_by, principal_type, principal_id, role)
     VALUES ($1, $2, $3, 'team', $4, $5)
     ON CONFLICT (file_id, principal_type, principal_id) WHERE revoked_at IS NULL AND principal_type IN ('user','team')
     DO UPDATE SET role = EXCLUDED.role
     RETURNING id`,
    [actor.organizationId, input.fileId, actor.userId, input.teamId, input.role],
  );

  const view = await queryOne<ShareRow>(`${SHARE_SELECT} WHERE s.id = $1`, [rows[0]!.id]);
  if (!view) throw AppError.internal('Share was created but could not be read back');
  return toShareView(view);
}

export interface CreateLinkInput {
  fileId: string;
  role: ResourceRole;
  expiresAt?: string;
}

/**
 * The link token is returned exactly once; only its hash is stored, so a
 * database dump cannot be used to open shared files.
 */
export async function createShareLink(
  actor: Actor,
  input: CreateLinkInput,
): Promise<{ share: ShareView; token: string }> {
  const file = await findFileById(actor.organizationId, input.fileId);
  if (!file) throw AppError.notFound('File not found');

  await requireFileAccess(actor.userId, subjectOf(file), 'owner');
  await assertSharingAllowed(actor.organizationId, 'link');

  const token = generateOpaqueToken();
  const shareId = randomUUID();

  try {
    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO shares (id, organization_id, file_id, shared_by, principal_type, role, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, 'link', $5, $6, $7)`,
        [
          shareId,
          actor.organizationId,
          input.fileId,
          actor.userId,
          input.role,
          hashOpaqueToken(token),
          input.expiresAt ? new Date(input.expiresAt) : null,
        ],
      );

      await recordAudit(tx, {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        action: 'file.link_shared',
        resourceType: 'file',
        resourceId: input.fileId,
        metadata: { role: input.role, expiresAt: input.expiresAt ?? null },
      });

      await publishEvent(
        tx,
        'file.shared',
        {
          organizationId: actor.organizationId,
          fileId: input.fileId,
          actorId: actor.userId,
          principalType: 'link',
          principalId: null,
          role: input.role,
        },
        { organizationId: actor.organizationId, actorId: actor.userId },
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict('Could not create the share link. Please try again.');
    }
    throw error;
  }

  const view = await queryOne<ShareRow>(`${SHARE_SELECT} WHERE s.id = $1`, [shareId]);
  if (!view) throw AppError.internal('Share link created but could not be read back');
  return { share: toShareView(view), token };
}

/** Anonymous access path used when someone opens a share link. */
export async function resolveShareLink(token: string): Promise<{ file: FileView; role: ResourceRole }> {
  const share = await queryOne<{ file_id: string; role: ResourceRole }>(
    `SELECT file_id, role
       FROM shares
      WHERE token_hash = $1
        AND principal_type = 'link'
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`,
    [hashOpaqueToken(token)],
  );

  if (!share) {
    throw AppError.notFound('This link is no longer valid. Ask the owner to share it again.');
  }

  const file = await findFileByIdUnscoped(share.file_id);
  if (!file || file.deleted_at) {
    throw AppError.notFound('The shared file is no longer available');
  }

  return { file: toFileView(file), role: share.role };
}

export async function listSharesForFile(actor: Actor, fileId: string): Promise<ShareView[]> {
  const file = await findFileByIdUnscoped(fileId);
  if (!file) throw AppError.notFound('File not found');
  await requireFileAccess(actor.userId, subjectOf(file), 'editor');

  const rows = await queryMany<ShareRow>(
    `${SHARE_SELECT} WHERE s.file_id = $1 AND s.revoked_at IS NULL ORDER BY s.created_at DESC`,
    [fileId],
  );
  return rows.map(toShareView);
}

/** Files other people have shared with the signed-in user. */
export async function listSharedWithMe(
  actor: Actor,
): Promise<
  Array<FileView & { sharedRole: ResourceRole; sharedAt: string; ownerName: string | null; ownerUsername: string | null }>
> {
  const rows = await queryMany<
    Parameters<typeof toFileView>[0] & {
      shared_role: ResourceRole;
      shared_at: Date;
      owner_name: string | null;
      owner_username: string | null;
    }
  >(
    `SELECT DISTINCT ON (f.id)
            f.id, f.organization_id, f.owner_id, f.parent_id, f.name, f.type, f.mime_type, f.size,
            f.storage_key, f.checksum, f.starred, f.pinned, f.version_no, f.metadata, f.deleted_at,
            f.created_at, f.updated_at, s.role AS shared_role, s.created_at AS shared_at,
            u.full_name AS owner_name, u.username AS owner_username
       FROM shares s
       JOIN files f ON f.id = s.file_id
       LEFT JOIN team_members tm ON s.principal_type = 'team' AND tm.team_id = s.principal_id
       LEFT JOIN users u ON u.id = f.owner_id
      WHERE s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > now())
        AND f.deleted_at IS NULL
        AND f.owner_id <> $1
        AND (
          (s.principal_type = 'user' AND s.principal_id = $1)
          OR (s.principal_type = 'team' AND tm.user_id = $1)
        )
      ORDER BY f.id, s.created_at DESC`,
    [actor.userId],
  );

  return rows.map((row) => ({
    ...toFileView(row),
    ownerUsername: row.owner_username,
    sharedRole: row.shared_role,
    sharedAt: row.shared_at.toISOString(),
    ownerName: row.owner_name,
  }));
}

export async function revokeShare(actor: Actor, shareId: string): Promise<void> {
  const share = await queryOne<{ file_id: string }>(
    'SELECT file_id FROM shares WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL',
    [shareId, actor.organizationId],
  );
  if (!share) throw AppError.notFound('Share not found');

  const file = await findFileById(actor.organizationId, share.file_id);
  if (!file) throw AppError.notFound('File not found');
  await requireFileAccess(actor.userId, subjectOf(file), 'owner');

  await withTransaction(async (tx) => {
    await tx.query('UPDATE shares SET revoked_at = now() WHERE id = $1', [shareId]);
    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'file.share_revoked',
      resourceType: 'file',
      resourceId: share.file_id,
      metadata: { shareId },
    });
  });
}

function subjectOf(file: { id: string; organization_id: string; owner_id: string }) {
  return { fileId: file.id, organizationId: file.organization_id, ownerId: file.owner_id };
}

export interface EligibleUser {
  id: string;
  name: string;
  email: string;
  username: string;
  avatarUrl: string | null;
}

/**
 * Candidates for "Share with...". Restricted to the caller's own contacts —
 * the app's existing notion of a connection (`modules/contacts`) — rather
 * than the full `users` table, so this cannot be used to discover arbitrary
 * accounts on the platform. Only owners can add people, so eligibility is
 * gated the same way `shareWithUser` is.
 */
export async function searchEligibleUsers(actor: Actor, fileId: string, term: string): Promise<EligibleUser[]> {
  const file = await findFileById(actor.organizationId, fileId);
  if (!file) throw AppError.notFound('File not found');
  await requireFileAccess(actor.userId, subjectOf(file), 'owner');

  const search = term.trim();
  if (search.length < 2) return [];

  const rows = await queryMany<{
    id: string;
    name: string;
    email: string;
    username: string;
    avatar_url: string | null;
  }>(
    `SELECT u.id, u.full_name AS name, u.email, u.username, u.avatar_url
       FROM contacts c
       JOIN users u ON u.id = c.contact_user_id
      WHERE c.owner_id = $1
        AND c.contact_user_id IS NOT NULL
        AND c.contact_user_id <> $1
        AND u.status <> 'deleted'
        AND (u.full_name ILIKE $2 OR u.email ILIKE $2 OR u.username ILIKE $2)
        AND NOT EXISTS (
          SELECT 1 FROM shares s
           WHERE s.file_id = $3
             AND s.revoked_at IS NULL
             AND s.principal_type = 'user'
             AND s.principal_id = u.id
        )
      ORDER BY u.full_name
      LIMIT 10`,
    [actor.userId, `%${search}%`, fileId],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    username: row.username,
    avatarUrl: row.avatar_url,
  }));
}

export interface FileActivityEntry {
  id: string;
  action: string;
  actorName: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

/**
 * Per-file activity for the Share dialog's "Activity History" tab. Reuses
 * the existing audit log (`modules/audit`) rather than a new log — the org-
 * wide `/audit-logs` route is admin-gated, which is the wrong bar for a file
 * owner viewing their own file's history, so this applies the file's own
 * permission check instead.
 */
export async function listFileActivity(actor: Actor, fileId: string): Promise<FileActivityEntry[]> {
  const file = await findFileByIdUnscoped(fileId);
  if (!file) throw AppError.notFound('File not found');
  await requireFileAccess(actor.userId, subjectOf(file), 'editor');

  const logs = await listAuditLogs({
    organizationId: file.organization_id,
    resourceType: 'file',
    resourceId: fileId,
    limit: 50,
    offset: 0,
  });

  return logs.map((log) => ({
    id: log.id,
    action: log.action,
    actorName: log.actorName,
    createdAt: log.createdAt,
    metadata: log.metadata,
  }));
}
