import mongoose from 'mongoose';

const workspaceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    type: { type: String, enum: ['personal', 'organization'], required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    settings: {
      defaultMailEnabled: { type: Boolean, default: true },
      allowExternalSharing: { type: Boolean, default: false },
      sharingPolicy: {
        mode: { type: String, enum: ['allow', 'warn', 'restrict', 'notify_specific'], default: 'restrict' },
        warningMessage: { type: String, default: 'External sharing is restricted in this workspace.' },
        notifyUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
      }
    },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

const membershipSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['owner', 'admin', 'manager', 'member', 'guest'], default: 'member' },
    status: { type: String, enum: ['active', 'pending', 'revoked'], default: 'active' },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    joinedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

export const Workspace = mongoose.model('Workspace', workspaceSchema);
export const Membership = mongoose.model('Membership', membershipSchema);

export async function createWorkspace(payload) {
  return Workspace.create(payload);
}

export async function findWorkspaceById(workspaceId) {
  return Workspace.findById(workspaceId);
}

export async function findPersonalWorkspaceByOwner(ownerId) {
  return Workspace.findOne({ ownerId, type: 'personal' });
}

export async function createMembership(payload) {
  return Membership.create(payload);
}

export async function findMembershipByUserAndWorkspace(userId, workspaceId) {
  return Membership.findOne({ userId, workspaceId, status: 'active' });
}

export async function findMembershipsForUser(userId) {
  return Membership.find({ userId, status: 'active' }).populate('workspaceId');
}

export async function findMembersForWorkspace(workspaceId) {
  return Membership.find({ workspaceId, status: 'active' }).populate('userId');
}

export async function updateWorkspace(workspaceId, payload) {
  return Workspace.findByIdAndUpdate(workspaceId, payload, { new: true });
}

export async function findWorkspaceBySlug(slug) {
  return Workspace.findOne({ slug });
}
