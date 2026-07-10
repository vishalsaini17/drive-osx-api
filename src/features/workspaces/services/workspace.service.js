import { AppError } from '../../../shared/common/AppError.js';
import { updateUser } from '../../auth/repositories/user.repository.js';
import {
  createMembership,
  createWorkspace,
  findMembersForWorkspace,
  findMembershipByUserAndWorkspace,
  findMembershipsForUser,
  findPersonalWorkspaceByOwner,
  findWorkspaceById,
  findWorkspaceBySlug,
  updateWorkspace
} from '../repositories/workspace.repository.js';

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function buildUniqueSlug(baseName) {
  const baseSlug = slugify(baseName) || 'workspace';
  let slug = baseSlug;
  let suffix = 1;

  while (true) {
    const existing = await findWorkspaceBySlug(slug);
    if (!existing) {
      return slug;
    }
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}

export class WorkspaceService {
  async createWorkspace(userId, { name, type }) {
    if (type === 'personal') {
      const existing = await findPersonalWorkspaceByOwner(userId);
      if (existing) {
        throw new AppError(409, 'Personal workspace already exists');
      }
    }

    const slug = await buildUniqueSlug(name);
    const workspace = await createWorkspace({
      name,
      slug,
      type,
      ownerId: userId,
      settings: {
        defaultMailEnabled: true,
        allowExternalSharing: false,
        sharingPolicy: {
          mode: 'restrict',
          warningMessage: 'External sharing is restricted in this workspace.',
          notifyUserIds: []
        }
      }
    });

    await createMembership({
      workspaceId: workspace._id,
      userId,
      role: 'owner',
      status: 'active'
    });

    await updateUser(userId, { currentWorkspaceId: workspace._id });

    return workspace;
  }

  async listWorkspaces(userId) {
    const memberships = await findMembershipsForUser(userId);
    return memberships.map((membership) => ({
      workspace: membership.workspaceId,
      role: membership.role,
      status: membership.status
    }));
  }

  async addMember(userId, workspaceId, { usernameOrEmail, role }) {
    const membership = await findMembershipByUserAndWorkspace(userId, workspaceId);
    if (!membership || !['owner', 'admin', 'manager'].includes(membership.role)) {
      throw new AppError(403, 'You are not allowed to manage members');
    }

    const workspace = await findWorkspaceById(workspaceId);
    if (!workspace) {
      throw new AppError(404, 'Workspace not found');
    }

    const targetUser = await findUserByUsernameOrEmail(usernameOrEmail);
    if (!targetUser) {
      throw new AppError(404, 'User not found');
    }

    const existingMembership = await findMembershipByUserAndWorkspace(targetUser._id, workspaceId);
    if (existingMembership) {
      throw new AppError(409, 'User already belongs to this workspace');
    }

    const createdMembership = await createMembership({
      workspaceId,
      userId: targetUser._id,
      role: role || 'member',
      status: 'active',
      invitedBy: userId
    });

    return createdMembership;
  }

  async switchWorkspace(userId, workspaceId) {
    const membership = await findMembershipByUserAndWorkspace(userId, workspaceId);
    if (!membership) {
      throw new AppError(404, 'Workspace membership not found');
    }

    await updateUser(userId, { currentWorkspaceId: workspaceId });

    return { message: 'Workspace switched successfully' };
  }

  async updateSharingPolicy(userId, workspaceId, payload) {
    const membership = await findMembershipByUserAndWorkspace(userId, workspaceId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new AppError(403, 'Only owners and admins can change sharing policy');
    }

    const workspace = await updateWorkspace(workspaceId, {
      settings: {
        ...workspace.settings,
        allowExternalSharing: payload.allowExternalSharing ?? false,
        sharingPolicy: {
          mode: payload.mode || 'restrict',
          warningMessage: payload.warningMessage || 'External sharing is restricted in this workspace.',
          notifyUserIds: payload.notifyUserIds || []
        }
      }
    });

    return workspace;
  }

  async listMembers(userId, workspaceId) {
    const membership = await findMembershipByUserAndWorkspace(userId, workspaceId);
    if (!membership) {
      throw new AppError(404, 'Workspace membership not found');
    }

    return findMembersForWorkspace(workspaceId);
  }
}

async function findUserByUsernameOrEmail(value) {
  const { User } = await import('../../auth/repositories/user.repository.js');
  return User.findOne({
    $or: [{ username: value }, { email: value }, { recoveryEmail: value }]
  });
}
