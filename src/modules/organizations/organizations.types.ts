import type { OrganizationRole } from '../../platform/authorization/roles.js';

export type OrganizationType = 'personal' | 'organization';

export interface SharingPolicy {
  mode: 'allow' | 'warn' | 'restrict' | 'notify_specific';
  warningMessage: string;
  notifyUserIds: string[];
}

export interface OrganizationSettings {
  defaultMailEnabled: boolean;
  allowExternalSharing: boolean;
  sharingPolicy: SharingPolicy;
}

export const defaultOrganizationSettings: OrganizationSettings = {
  defaultMailEnabled: true,
  allowExternalSharing: false,
  sharingPolicy: {
    mode: 'restrict',
    warningMessage: 'External sharing is restricted in this workspace.',
    notifyUserIds: [],
  },
};

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  type: OrganizationType;
  owner_id: string | null;
  settings: Partial<OrganizationSettings> | null;
  storage_quota_bytes: string | number;
  storage_used_bytes: string | number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface OrganizationView {
  id: string;
  /** Legacy alias: existing clients read `_id`. */
  _id: string;
  name: string;
  slug: string;
  type: OrganizationType;
  ownerId: string | null;
  settings: OrganizationSettings;
  storage: { quotaBytes: number; usedBytes: number };
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toOrganizationView(row: OrganizationRow): OrganizationView {
  return {
    id: row.id,
    _id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    ownerId: row.owner_id,
    settings: {
      ...defaultOrganizationSettings,
      ...(row.settings ?? {}),
      sharingPolicy: {
        ...defaultOrganizationSettings.sharingPolicy,
        ...(row.settings?.sharingPolicy ?? {}),
      },
    },
    storage: {
      quotaBytes: Number(row.storage_quota_bytes),
      usedBytes: Number(row.storage_used_bytes),
    },
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface MembershipRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
  status: 'active' | 'pending' | 'revoked';
  invited_by: string | null;
  joined_at: Date;
}

export interface MemberView {
  id: string;
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  status: 'active' | 'pending' | 'revoked';
  joinedAt: string;
  user: {
    id: string;
    username: string;
    fullName: string;
    email: string;
    avatarUrl: string | null;
  };
}
