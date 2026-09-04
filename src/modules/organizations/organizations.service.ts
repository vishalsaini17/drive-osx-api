import { randomBytes } from 'node:crypto';
import { env } from '../../platform/configuration/env.js';
import { AppError } from '../../platform/errors/app-error.js';
import { publishEvent } from '../../platform/events/event-bus.js';
import { invalidateMembership, requireMembership, requirePermission } from '../../platform/authorization/access-control.js';
import type { OrganizationRole } from '../../platform/authorization/roles.js';
import { isUniqueViolation, withTransaction, type Queryable } from '../../infrastructure/database/pool.js';
import { recordAudit } from '../audit/audit.service.js';
import { findUserByAnyIdentifier, setCurrentOrganization } from '../identity/identity.repository.js';
import { provisionDefaultFolders } from '../files/files.service.js';
import * as repository from './organizations.repository.js';
import {
  defaultOrganizationSettings,
  toOrganizationView,
  type MemberView,
  type OrganizationSettings,
  type OrganizationType,
  type OrganizationView,
  type SharingPolicy,
} from './organizations.types.js';

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 48) || 'workspace'
  );
}

async function buildUniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  if (!(await repository.findOrganizationBySlug(base))) {
    return base;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${base}-${randomBytes(3).toString('hex')}`;
    if (!(await repository.findOrganizationBySlug(candidate))) {
      return candidate;
    }
  }

  throw AppError.conflict('Could not allocate a unique workspace address. Try a different name.');
}

export interface CreateOrganizationInput {
  name: string;
  type: OrganizationType;
}

/**
 * Creates an organization, its owner membership and its drive in one
 * transaction — a tenant is never half-created.
 */
export async function createOrganization(
  userId: string,
  input: CreateOrganizationInput,
): Promise<OrganizationView> {
  if (input.type === 'personal') {
    const existing = await repository.findPersonalOrganizationByOwner(userId);
    if (existing) {
      throw AppError.conflict('You already have a personal workspace');
    }
  }

  const slug = await buildUniqueSlug(input.name);

  try {
    const row = await withTransaction(async (tx) => {
      const organization = await repository.insertOrganization(tx, {
        name: input.name.trim(),
        slug,
        type: input.type,
        ownerId: userId,
        settings: defaultOrganizationSettings,
        storageQuotaBytes: env.DEFAULT_STORAGE_QUOTA_BYTES,
      });

      await repository.insertMembership(tx, {
        organizationId: organization.id,
        userId,
        role: 'owner',
      });

      await setCurrentOrganization(tx, userId, organization.id, input.type === 'personal');
      await provisionDefaultFolders(tx, { organizationId: organization.id, ownerId: userId });

      await recordAudit(tx, {
        organizationId: organization.id,
        actorId: userId,
        action: 'organization.created',
        resourceType: 'organization',
        resourceId: organization.id,
        metadata: { name: organization.name, type: organization.type },
      });

      await publishEvent(
        tx,
        'organization.created',
        { organizationId: organization.id, ownerId: userId, type: organization.type },
        { organizationId: organization.id, actorId: userId },
      );

      return organization;
    });

    await invalidateMembership(userId, row.id);
    return toOrganizationView(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict('A workspace with this address already exists');
    }
    throw error;
  }
}

/** Same operation, joined to an in-flight transaction (used during registration). */
export async function createOrganizationInTransaction(
  tx: Queryable,
  userId: string,
  input: CreateOrganizationInput & { slug: string },
): Promise<OrganizationView> {
  const organization = await repository.insertOrganization(tx, {
    name: input.name.trim(),
    slug: input.slug,
    type: input.type,
    ownerId: userId,
    settings: defaultOrganizationSettings,
    storageQuotaBytes: env.DEFAULT_STORAGE_QUOTA_BYTES,
  });

  await repository.insertMembership(tx, { organizationId: organization.id, userId, role: 'owner' });
  await setCurrentOrganization(tx, userId, organization.id, true);
  await provisionDefaultFolders(tx, { organizationId: organization.id, ownerId: userId });

  await publishEvent(
    tx,
    'organization.created',
    { organizationId: organization.id, ownerId: userId, type: organization.type },
    { organizationId: organization.id, actorId: userId },
  );

  return toOrganizationView(organization);
}

export async function reserveSlug(name: string): Promise<string> {
  return buildUniqueSlug(name);
}

export interface OrganizationMembershipView {
  organization: OrganizationView;
  role: OrganizationRole;
  status: string;
}

export async function listForUser(userId: string): Promise<OrganizationMembershipView[]> {
  const memberships = await repository.findMembershipsForUser(userId);
  return memberships.map((membership) => ({
    organization: toOrganizationView(membership.organization),
    role: membership.role,
    status: membership.status,
  }));
}

export async function getOrganization(userId: string, organizationId: string): Promise<OrganizationView> {
  await requireMembership(userId, organizationId);
  const organization = await repository.findOrganizationById(organizationId);
  if (!organization) throw AppError.notFound('Workspace not found');
  return toOrganizationView(organization);
}

export async function listMembers(userId: string, organizationId: string): Promise<MemberView[]> {
  await requirePermission(userId, organizationId, 'member:read');
  return repository.findMembersForOrganization(organizationId);
}

export interface AddMemberInput {
  usernameOrEmail: string;
  role?: OrganizationRole;
}

export async function addMember(
  actorId: string,
  organizationId: string,
  input: AddMemberInput,
): Promise<MemberView> {
  const actorMembership = await requirePermission(actorId, organizationId, 'member:invite');

  // Only owners may mint another owner.
  const role = input.role ?? 'member';
  if (role === 'owner' && actorMembership.role !== 'owner') {
    throw AppError.permission('Only a workspace owner can grant the owner role');
  }

  const organization = await repository.findOrganizationById(organizationId);
  if (!organization) throw AppError.notFound('Workspace not found');
  if (organization.type === 'personal') {
    throw AppError.validation('A personal workspace cannot have additional members');
  }

  const target = await findUserByAnyIdentifier(input.usernameOrEmail);
  if (!target) {
    throw AppError.notFound(`No user found for "${input.usernameOrEmail}"`);
  }

  const existing = await repository.findMembership(target.id, organizationId);
  if (existing && existing.status === 'active') {
    throw AppError.conflict('This person is already a member of the workspace');
  }

  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO memberships (organization_id, user_id, role, status, invited_by)
       VALUES ($1, $2, $3, 'active', $4)
       ON CONFLICT (organization_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, status = 'active', invited_by = EXCLUDED.invited_by`,
      [organizationId, target.id, role, actorId],
    );

    await recordAudit(tx, {
      organizationId,
      actorId,
      action: 'member.added',
      resourceType: 'membership',
      resourceId: target.id,
      metadata: { role, username: target.username },
    });

    await publishEvent(
      tx,
      'organization.member_added',
      { organizationId, userId: target.id, role, invitedBy: actorId },
      { organizationId, actorId },
    );
  });

  await invalidateMembership(target.id, organizationId);

  const members = await repository.findMembersForOrganization(organizationId);
  const member = members.find((entry) => entry.userId === target.id);
  if (!member) throw AppError.internal('Member was added but could not be read back');
  return member;
}

export async function updateMemberRole(
  actorId: string,
  organizationId: string,
  targetUserId: string,
  role: OrganizationRole,
): Promise<MemberView> {
  const actorMembership = await requirePermission(actorId, organizationId, 'member:update_role');

  if (role === 'owner' && actorMembership.role !== 'owner') {
    throw AppError.permission('Only a workspace owner can grant the owner role');
  }

  const target = await repository.findMembership(targetUserId, organizationId);
  if (!target || target.status !== 'active') {
    throw AppError.notFound('This person is not a member of the workspace');
  }

  // Never leave a workspace without an owner.
  if (target.role === 'owner' && role !== 'owner') {
    const owners = Number((await repository.countOwners(organizationId))?.count ?? 0);
    if (owners <= 1) {
      throw AppError.conflict('A workspace must always have at least one owner');
    }
  }

  await repository.updateMemberRole(organizationId, targetUserId, role);
  await invalidateMembership(targetUserId, organizationId);

  const members = await repository.findMembersForOrganization(organizationId);
  const member = members.find((entry) => entry.userId === targetUserId);
  if (!member) throw AppError.internal('Membership updated but could not be read back');
  return member;
}

export async function removeMember(
  actorId: string,
  organizationId: string,
  targetUserId: string,
): Promise<void> {
  await requirePermission(actorId, organizationId, 'member:remove');

  const target = await repository.findMembership(targetUserId, organizationId);
  if (!target || target.status !== 'active') {
    throw AppError.notFound('This person is not a member of the workspace');
  }

  if (target.role === 'owner') {
    const owners = Number((await repository.countOwners(organizationId))?.count ?? 0);
    if (owners <= 1) {
      throw AppError.conflict('The last owner cannot be removed from a workspace');
    }
  }

  await withTransaction(async (tx) => {
    await tx.query(`UPDATE memberships SET status = 'revoked' WHERE organization_id = $1 AND user_id = $2`, [
      organizationId,
      targetUserId,
    ]);
    await recordAudit(tx, {
      organizationId,
      actorId,
      action: 'member.removed',
      resourceType: 'membership',
      resourceId: targetUserId,
    });
  });

  await invalidateMembership(targetUserId, organizationId);
}

export async function switchOrganization(userId: string, organizationId: string): Promise<OrganizationView> {
  await requireMembership(userId, organizationId);

  const organization = await withTransaction(async (tx) => {
    await setCurrentOrganization(tx, userId, organizationId);
    return repository.findOrganizationById(organizationId);
  });

  if (!organization) throw AppError.notFound('Workspace not found');
  return toOrganizationView(organization);
}

export interface SharingPolicyInput {
  allowExternalSharing?: boolean;
  mode?: SharingPolicy['mode'];
  warningMessage?: string;
  notifyUserIds?: string[];
}

export async function updateSharingPolicy(
  actorId: string,
  organizationId: string,
  input: SharingPolicyInput,
): Promise<OrganizationView> {
  await requirePermission(actorId, organizationId, 'settings:manage');

  const organization = await repository.findOrganizationById(organizationId);
  if (!organization) throw AppError.notFound('Workspace not found');

  const current = toOrganizationView(organization).settings;
  const next: OrganizationSettings = {
    ...current,
    allowExternalSharing: input.allowExternalSharing ?? current.allowExternalSharing,
    sharingPolicy: {
      mode: input.mode ?? current.sharingPolicy.mode,
      warningMessage: input.warningMessage ?? current.sharingPolicy.warningMessage,
      notifyUserIds: input.notifyUserIds ?? current.sharingPolicy.notifyUserIds,
    },
  };

  const updated = await repository.updateOrganizationSettings(organizationId, next);
  if (!updated) throw AppError.notFound('Workspace not found');

  await withTransaction((tx) =>
    recordAudit(tx, {
      organizationId,
      actorId,
      action: 'organization.sharing_policy_updated',
      resourceType: 'organization',
      resourceId: organizationId,
      metadata: { ...next.sharingPolicy, allowExternalSharing: next.allowExternalSharing },
    }),
  );

  return toOrganizationView(updated);
}

export async function getStorageSummary(
  userId: string,
  organizationId: string,
): Promise<{ usedBytes: number; quotaBytes: number; percentUsed: number }> {
  await requireMembership(userId, organizationId);
  const usage = await repository.getStorageUsage(organizationId);
  if (!usage) throw AppError.notFound('Workspace not found');

  const usedBytes = Number(usage.used);
  const quotaBytes = Number(usage.quota);
  return {
    usedBytes,
    quotaBytes,
    percentUsed: quotaBytes === 0 ? 0 : Math.min(100, Math.round((usedBytes / quotaBytes) * 100)),
  };
}

// ------------------------------------------------------------------ teams

export async function createTeam(
  actorId: string,
  organizationId: string,
  input: { name: string; description?: string },
): Promise<repository.TeamRow> {
  await requirePermission(actorId, organizationId, 'team:manage');

  try {
    return await withTransaction(async (tx) => {
      const team = await repository.insertTeam(tx, {
        organizationId,
        name: input.name.trim(),
        slug: slugify(input.name),
        description: input.description?.trim() ?? '',
        createdBy: actorId,
      });

      await recordAudit(tx, {
        organizationId,
        actorId,
        action: 'team.created',
        resourceType: 'team',
        resourceId: team.id,
        metadata: { name: team.name },
      });

      return team;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict('A team with this name already exists in the workspace');
    }
    throw error;
  }
}

export async function listTeams(actorId: string, organizationId: string): Promise<repository.TeamRow[]> {
  await requireMembership(actorId, organizationId);
  return repository.findTeams(organizationId);
}

export async function addTeamMember(
  actorId: string,
  organizationId: string,
  teamId: string,
  targetUserId: string,
  role: 'lead' | 'member' = 'member',
): Promise<void> {
  await requirePermission(actorId, organizationId, 'team:manage');

  const team = await repository.findTeamById(teamId, organizationId);
  if (!team) throw AppError.notFound('Team not found');

  const membership = await repository.findMembership(targetUserId, organizationId);
  if (!membership || membership.status !== 'active') {
    throw AppError.validation('Only workspace members can be added to a team');
  }

  await repository.addTeamMember(teamId, targetUserId, role);
}

export async function removeTeamMember(
  actorId: string,
  organizationId: string,
  teamId: string,
  targetUserId: string,
): Promise<void> {
  await requirePermission(actorId, organizationId, 'team:manage');

  const team = await repository.findTeamById(teamId, organizationId);
  if (!team) throw AppError.notFound('Team not found');

  await repository.removeTeamMember(teamId, targetUserId);
}

export async function listTeamMembers(
  actorId: string,
  organizationId: string,
  teamId: string,
): Promise<Array<{ userId: string; role: string; fullName: string }>> {
  await requireMembership(actorId, organizationId);

  const team = await repository.findTeamById(teamId, organizationId);
  if (!team) throw AppError.notFound('Team not found');

  return repository.findTeamMembers(teamId);
}
