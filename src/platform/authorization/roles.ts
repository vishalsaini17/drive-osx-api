/**
 * Authorization model (CLAUDE.md §17):
 *
 *   Can USER perform ACTION on RESOURCE within ORGANIZATION?
 *
 * Role → permission mapping lives here and nowhere else. Controllers ask the
 * access-control service; they never re-implement rules.
 */
export const ORGANIZATION_ROLES = ['owner', 'admin', 'manager', 'member', 'guest'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const RESOURCE_ROLES = ['owner', 'editor', 'commenter', 'viewer'] as const;
export type ResourceRole = (typeof RESOURCE_ROLES)[number];

export type Permission =
  | 'organization:read'
  | 'organization:update'
  | 'organization:delete'
  | 'member:read'
  | 'member:invite'
  | 'member:update_role'
  | 'member:remove'
  | 'team:manage'
  | 'file:create'
  | 'file:read_own'
  | 'file:share_external'
  | 'billing:manage'
  | 'audit:read'
  | 'settings:manage';

const ROLE_PERMISSIONS: Record<OrganizationRole, readonly Permission[]> = {
  owner: [
    'organization:read',
    'organization:update',
    'organization:delete',
    'member:read',
    'member:invite',
    'member:update_role',
    'member:remove',
    'team:manage',
    'file:create',
    'file:read_own',
    'file:share_external',
    'billing:manage',
    'audit:read',
    'settings:manage',
  ],
  admin: [
    'organization:read',
    'organization:update',
    'member:read',
    'member:invite',
    'member:update_role',
    'member:remove',
    'team:manage',
    'file:create',
    'file:read_own',
    'file:share_external',
    'audit:read',
    'settings:manage',
  ],
  manager: [
    'organization:read',
    'member:read',
    'member:invite',
    'team:manage',
    'file:create',
    'file:read_own',
    'file:share_external',
  ],
  member: ['organization:read', 'member:read', 'file:create', 'file:read_own'],
  guest: ['organization:read', 'file:read_own'],
};

export function permissionsForRole(role: OrganizationRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHasPermission(role: OrganizationRole, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

const RESOURCE_ROLE_RANK: Record<ResourceRole, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  owner: 4,
};

export function resourceRoleAtLeast(actual: ResourceRole, required: ResourceRole): boolean {
  return RESOURCE_ROLE_RANK[actual] >= RESOURCE_ROLE_RANK[required];
}

/** The strongest of several grants (own + team + link) wins. */
export function highestResourceRole(roles: readonly ResourceRole[]): ResourceRole | null {
  let best: ResourceRole | null = null;
  for (const role of roles) {
    if (!best || RESOURCE_ROLE_RANK[role] > RESOURCE_ROLE_RANK[best]) {
      best = role;
    }
  }
  return best;
}

/**
 * Organization role floor for resources inside the tenant. Owners and admins
 * administer tenant content; everyone else needs an explicit grant.
 */
export function resourceRoleFromOrganizationRole(role: OrganizationRole): ResourceRole | null {
  switch (role) {
    case 'owner':
    case 'admin':
      return 'editor';
    default:
      return null;
  }
}
