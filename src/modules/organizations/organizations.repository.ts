import { query, queryMany, queryOne, type Queryable } from '../../infrastructure/database/pool.js';
import type { OrganizationRole } from '../../platform/authorization/roles.js';
import type {
  MemberView,
  MembershipRow,
  OrganizationRow,
  OrganizationSettings,
  OrganizationType,
} from './organizations.types.js';

const ORGANIZATION_COLUMNS = `
  id, name, slug, type, owner_id, settings, storage_quota_bytes, storage_used_bytes,
  is_active, created_at, updated_at
`;

export interface InsertOrganizationInput {
  name: string;
  slug: string;
  type: OrganizationType;
  ownerId: string;
  settings: OrganizationSettings;
  storageQuotaBytes: number;
}

export async function insertOrganization(
  tx: Queryable,
  input: InsertOrganizationInput,
): Promise<OrganizationRow> {
  const { rows } = await tx.query<OrganizationRow>(
    `INSERT INTO organizations (name, slug, type, owner_id, settings, storage_quota_bytes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ORGANIZATION_COLUMNS}`,
    [input.name, input.slug, input.type, input.ownerId, JSON.stringify(input.settings), input.storageQuotaBytes],
  );
  return rows[0]!;
}

export function findOrganizationById(organizationId: string): Promise<OrganizationRow | null> {
  return queryOne<OrganizationRow>(`SELECT ${ORGANIZATION_COLUMNS} FROM organizations WHERE id = $1`, [
    organizationId,
  ]);
}

export function findOrganizationBySlug(slug: string): Promise<OrganizationRow | null> {
  return queryOne<OrganizationRow>(`SELECT ${ORGANIZATION_COLUMNS} FROM organizations WHERE slug = $1`, [slug]);
}

export function findPersonalOrganizationByOwner(ownerId: string): Promise<OrganizationRow | null> {
  return queryOne<OrganizationRow>(
    `SELECT ${ORGANIZATION_COLUMNS} FROM organizations WHERE owner_id = $1 AND type = 'personal'`,
    [ownerId],
  );
}

export async function updateOrganizationSettings(
  organizationId: string,
  settings: OrganizationSettings,
): Promise<OrganizationRow | null> {
  return queryOne<OrganizationRow>(
    `UPDATE organizations SET settings = $2 WHERE id = $1 RETURNING ${ORGANIZATION_COLUMNS}`,
    [organizationId, JSON.stringify(settings)],
  );
}

/**
 * Storage accounting is a single atomic statement so concurrent uploads cannot
 * lose an increment.
 */
export async function addStorageUsage(tx: Queryable, organizationId: string, deltaBytes: number): Promise<void> {
  await tx.query(
    `UPDATE organizations
        SET storage_used_bytes = GREATEST(0, storage_used_bytes + $2)
      WHERE id = $1`,
    [organizationId, deltaBytes],
  );
}

export function getStorageUsage(
  organizationId: string,
): Promise<{ used: string; quota: string } | null> {
  return queryOne<{ used: string; quota: string }>(
    'SELECT storage_used_bytes AS used, storage_quota_bytes AS quota FROM organizations WHERE id = $1',
    [organizationId],
  );
}

// ------------------------------------------------------------- memberships

export async function insertMembership(
  tx: Queryable,
  input: { organizationId: string; userId: string; role: OrganizationRole; invitedBy?: string | null },
): Promise<MembershipRow> {
  const { rows } = await tx.query<MembershipRow>(
    `INSERT INTO memberships (organization_id, user_id, role, status, invited_by)
     VALUES ($1, $2, $3, 'active', $4)
     RETURNING id, organization_id, user_id, role, status, invited_by, joined_at`,
    [input.organizationId, input.userId, input.role, input.invitedBy ?? null],
  );
  return rows[0]!;
}

export function findMembership(userId: string, organizationId: string): Promise<MembershipRow | null> {
  return queryOne<MembershipRow>(
    `SELECT id, organization_id, user_id, role, status, invited_by, joined_at
       FROM memberships
      WHERE user_id = $1 AND organization_id = $2`,
    [userId, organizationId],
  );
}

export interface MembershipWithOrganization {
  role: OrganizationRole;
  status: 'active' | 'pending' | 'revoked';
  organization: OrganizationRow;
}

export async function findMembershipsForUser(userId: string): Promise<MembershipWithOrganization[]> {
  const rows = await queryMany<OrganizationRow & { member_role: OrganizationRole; member_status: MembershipRow['status'] }>(
    `SELECT o.id, o.name, o.slug, o.type, o.owner_id, o.settings, o.storage_quota_bytes,
            o.storage_used_bytes, o.is_active, o.created_at, o.updated_at,
            m.role AS member_role, m.status AS member_status
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY o.created_at`,
    [userId],
  );

  return rows.map(({ member_role, member_status, ...organization }) => ({
    role: member_role,
    status: member_status,
    organization,
  }));
}

export function findMembersForOrganization(organizationId: string): Promise<MemberView[]> {
  return queryMany<MemberView>(
    `SELECT m.id,
            m.user_id        AS "userId",
            m.organization_id AS "organizationId",
            m.role,
            m.status,
            m.joined_at      AS "joinedAt",
            jsonb_build_object(
              'id', u.id,
              'username', u.username,
              'fullName', u.full_name,
              'email', u.email,
              'avatarUrl', u.avatar_url
            ) AS user
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.status = 'active'
      ORDER BY m.joined_at`,
    [organizationId],
  );
}

export async function updateMemberRole(
  organizationId: string,
  userId: string,
  role: OrganizationRole,
): Promise<MembershipRow | null> {
  return queryOne<MembershipRow>(
    `UPDATE memberships
        SET role = $3
      WHERE organization_id = $1 AND user_id = $2
      RETURNING id, organization_id, user_id, role, status, invited_by, joined_at`,
    [organizationId, userId, role],
  );
}

export async function revokeMembership(organizationId: string, userId: string): Promise<void> {
  await query(
    `UPDATE memberships SET status = 'revoked' WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId],
  );
}

export function countOwners(organizationId: string): Promise<{ count: string } | null> {
  return queryOne<{ count: string }>(
    `SELECT count(*) AS count FROM memberships WHERE organization_id = $1 AND role = 'owner' AND status = 'active'`,
    [organizationId],
  );
}

// ------------------------------------------------------------------ teams

export interface TeamRow {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  description: string;
  created_at: Date;
}

export async function insertTeam(
  tx: Queryable,
  input: { organizationId: string; name: string; slug: string; description: string; createdBy: string },
): Promise<TeamRow> {
  const { rows } = await tx.query<TeamRow>(
    `INSERT INTO teams (organization_id, name, slug, description, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, organization_id, name, slug, description, created_at`,
    [input.organizationId, input.name, input.slug, input.description, input.createdBy],
  );
  return rows[0]!;
}

export function findTeams(organizationId: string): Promise<TeamRow[]> {
  return queryMany<TeamRow>(
    `SELECT id, organization_id, name, slug, description, created_at
       FROM teams WHERE organization_id = $1 ORDER BY name`,
    [organizationId],
  );
}

export function findTeamById(teamId: string, organizationId: string): Promise<TeamRow | null> {
  return queryOne<TeamRow>(
    `SELECT id, organization_id, name, slug, description, created_at
       FROM teams WHERE id = $1 AND organization_id = $2`,
    [teamId, organizationId],
  );
}

export async function addTeamMember(teamId: string, userId: string, role: 'lead' | 'member'): Promise<void> {
  await query(
    `INSERT INTO team_members (team_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [teamId, userId, role],
  );
}

export async function removeTeamMember(teamId: string, userId: string): Promise<void> {
  await query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId]);
}

export function findTeamMembers(teamId: string): Promise<Array<{ userId: string; role: string; fullName: string }>> {
  return queryMany<{ userId: string; role: string; fullName: string }>(
    `SELECT tm.user_id AS "userId", tm.role, u.full_name AS "fullName"
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1
      ORDER BY u.full_name`,
    [teamId],
  );
}
