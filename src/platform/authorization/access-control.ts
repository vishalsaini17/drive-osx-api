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
 * Effective role a user holds on a file: ownership, organization
 * administration, direct share, or team share — strongest grant wins.
 */
export async function effectiveFileRole(
  userId: string,
  file: FileAccessSubject,
): Promise<ResourceRole | null> {
  if (file.ownerId === userId) return 'owner';

  const membership = await loadMembership(userId, file.organizationId);
  if (!membership) return null;

  const grants: ResourceRole[] = [];

  const fromOrganization = resourceRoleFromOrganizationRole(membership.role);
  if (fromOrganization) grants.push(fromOrganization);

  const shares = await queryMany<{ role: ResourceRole }>(
    `SELECT s.role
       FROM shares s
       LEFT JOIN team_members tm ON s.principal_type = 'team' AND tm.team_id = s.principal_id
      WHERE s.file_id = $1
        AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > now())
        AND (
          (s.principal_type = 'user' AND s.principal_id = $2)
          OR (s.principal_type = 'team' AND tm.user_id = $2)
          OR s.principal_type = 'organization'
        )`,
    [file.fileId, userId],
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
