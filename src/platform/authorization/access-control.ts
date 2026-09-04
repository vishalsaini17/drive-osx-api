import { queryMany, queryOne } from '../../infrastructure/database/pool.js';
import { cacheKeys, cacheDelete, cached } from '../../infrastructure/redis/cache.js';
import { AppError } from '../errors/app-error.js';
import {
  highestResourceRole,
  resourceRoleAtLeast,
  resourceRoleFromOrganizationRole,
  roleHasPermission,
  type OrganizationRole,
  type Permission,
  type ResourceRole,
} from './roles.js';

export interface MembershipContext {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  status: 'active' | 'pending' | 'revoked';
}

/**
 * Central authorization service. All resource access decisions are made here,
 * server-side, regardless of what the client believes (CLAUDE.md §17, §28).
 */
export async function loadMembership(userId: string, organizationId: string): Promise<MembershipContext | null> {
  return cached(cacheKeys.membership(userId, organizationId), 60, async () =>
    queryOne<MembershipContext>(
      `SELECT organization_id AS "organizationId", user_id AS "userId", role, status
         FROM memberships
        WHERE user_id = $1 AND organization_id = $2 AND status = 'active'`,
      [userId, organizationId],
    ),
  );
}

export async function invalidateMembership(userId: string, organizationId: string): Promise<void> {
  await cacheDelete(cacheKeys.membership(userId, organizationId), cacheKeys.organizationMembers(organizationId));
}

export async function requireMembership(userId: string, organizationId: string): Promise<MembershipContext> {
  const membership = await loadMembership(userId, organizationId);
  if (!membership) {
    // Deliberately "not found": membership is itself sensitive information.
    throw AppError.notFound('Organization not found');
  }
  return membership;
}

export async function requirePermission(
  userId: string,
  organizationId: string,
  permission: Permission,
): Promise<MembershipContext> {
  const membership = await requireMembership(userId, organizationId);
  if (!roleHasPermission(membership.role, permission)) {
    throw AppError.permission(`Your role (${membership.role}) cannot perform this action`);
  }
  return membership;
}

export interface FileAccessSubject {
  fileId: string;
  organizationId: string;
  ownerId: string;
}

/**
 * A file's ancestor folder ids, nearest first, not including the file itself.
 * Bounded by folder depth — cheap at this scale, no closure table needed.
 */
async function ancestorFolderIds(fileId: string): Promise<string[]> {
  const rows = await queryMany<{ id: string }>(
    `WITH RECURSIVE ancestors AS (
       SELECT parent_id AS id FROM files WHERE id = $1
       UNION ALL
       SELECT f.parent_id AS id FROM files f JOIN ancestors a ON f.id = a.id WHERE f.parent_id IS NOT NULL
     )
     SELECT id FROM ancestors WHERE id IS NOT NULL`,
    [fileId],
  );
  return rows.map((row) => row.id);
}

/**
 * Effective role a user holds on a file: ownership, organization
 * administration, direct share, team share, or a share on an ancestor
 * folder — strongest grant wins. Sharing a folder implicitly shares
 * everything inside it, the same way a filesystem permission would.
 */
export async function effectiveFileRole(
  userId: string,
  file: FileAccessSubject,
): Promise<ResourceRole | null> {
  if (file.ownerId === userId) return 'owner';

  const grants: ResourceRole[] = [];

  // Organization administration only grants access within that same org — but
  // a share can still apply even when the actor has no membership there at
  // all, since every user gets their own personal org (CLAUDE.md/docs
  // "Every user starts alone in their own tenant") and direct shares are the
  // one path meant to cross that boundary. So membership is optional here,
  // not a gate on whether shares get checked below.
  const membership = await loadMembership(userId, file.organizationId);
  if (membership) {
    const fromOrganization = resourceRoleFromOrganizationRole(membership.role);
    if (fromOrganization) grants.push(fromOrganization);
  }

  const ancestorIds = await ancestorFolderIds(file.fileId);
  const shareableIds = [file.fileId, ...ancestorIds];

  const shares = await queryMany<{ role: ResourceRole }>(
    `SELECT s.role
       FROM shares s
       LEFT JOIN team_members tm ON s.principal_type = 'team' AND tm.team_id = s.principal_id
      WHERE s.file_id = ANY($1::uuid[])
        AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > now())
        AND (
          (s.principal_type = 'user' AND s.principal_id = $2)
          OR (s.principal_type = 'team' AND tm.user_id = $2)
          OR s.principal_type = 'organization'
        )`,
    [shareableIds, userId],
  );

  grants.push(...shares.map((share) => share.role));

  return highestResourceRole(grants);
}

export async function requireFileAccess(
  userId: string,
  file: FileAccessSubject,
  required: ResourceRole,
): Promise<ResourceRole> {
  const role = await effectiveFileRole(userId, file);

  if (!role) {
    // Do not disclose that the file exists.
    throw AppError.notFound('File not found');
  }

  if (!resourceRoleAtLeast(role, required)) {
    throw AppError.permission(
      `You have ${role} access to this file; ${required} access is required for this action`,
    );
  }

  return role;
}

/** Non-throwing variant for list endpoints and UI capability hints. */
export async function canAccessFile(
  userId: string,
  file: FileAccessSubject,
  required: ResourceRole,
): Promise<boolean> {
  const role = await effectiveFileRole(userId, file);
  return role !== null && resourceRoleAtLeast(role, required);
}
