import { describe, expect, it } from 'vitest';
import {
  highestResourceRole,
  permissionsForRole,
  resourceRoleAtLeast,
  resourceRoleFromOrganizationRole,
  roleHasPermission,
  ORGANIZATION_ROLES,
  type OrganizationRole,
} from './roles.js';

describe('organization roles', () => {
  it('gives owners every permission an admin has', () => {
    for (const permission of permissionsForRole('admin')) {
      expect(roleHasPermission('owner', permission)).toBe(true);
    }
  });

  it('reserves destructive workspace permissions for owners', () => {
    expect(roleHasPermission('owner', 'organization:delete')).toBe(true);
    expect(roleHasPermission('admin', 'organization:delete')).toBe(false);
    expect(roleHasPermission('manager', 'organization:delete')).toBe(false);
  });

  it('does not let members manage other members', () => {
    const nonManaging: OrganizationRole[] = ['member', 'guest'];
    for (const role of nonManaging) {
      expect(roleHasPermission(role, 'member:invite')).toBe(false);
      expect(roleHasPermission(role, 'member:remove')).toBe(false);
      expect(roleHasPermission(role, 'member:update_role')).toBe(false);
    }
  });

  it('restricts the audit trail to administrative roles', () => {
    expect(roleHasPermission('owner', 'audit:read')).toBe(true);
    expect(roleHasPermission('admin', 'audit:read')).toBe(true);
    expect(roleHasPermission('manager', 'audit:read')).toBe(false);
    expect(roleHasPermission('member', 'audit:read')).toBe(false);
  });

  it('lets guests read but never create', () => {
    expect(roleHasPermission('guest', 'organization:read')).toBe(true);
    expect(roleHasPermission('guest', 'file:create')).toBe(false);
  });

  it('defines permissions for every declared role', () => {
    for (const role of ORGANIZATION_ROLES) {
      expect(permissionsForRole(role).length).toBeGreaterThan(0);
    }
  });
});

describe('resource roles', () => {
  it('orders roles from viewer to owner', () => {
    expect(resourceRoleAtLeast('owner', 'editor')).toBe(true);
    expect(resourceRoleAtLeast('editor', 'commenter')).toBe(true);
    expect(resourceRoleAtLeast('commenter', 'viewer')).toBe(true);
    expect(resourceRoleAtLeast('viewer', 'commenter')).toBe(false);
    expect(resourceRoleAtLeast('editor', 'owner')).toBe(false);
  });

  it('treats an equal role as sufficient', () => {
    expect(resourceRoleAtLeast('editor', 'editor')).toBe(true);
  });

  it('takes the strongest grant when several apply', () => {
    expect(highestResourceRole(['viewer', 'editor', 'commenter'])).toBe('editor');
    expect(highestResourceRole(['viewer'])).toBe('viewer');
    expect(highestResourceRole([])).toBeNull();
  });

  it('gives workspace administrators edit access but not ownership', () => {
    expect(resourceRoleFromOrganizationRole('owner')).toBe('editor');
    expect(resourceRoleFromOrganizationRole('admin')).toBe('editor');
  });

  it('requires an explicit grant for everyone below admin', () => {
    expect(resourceRoleFromOrganizationRole('manager')).toBeNull();
    expect(resourceRoleFromOrganizationRole('member')).toBeNull();
    expect(resourceRoleFromOrganizationRole('guest')).toBeNull();
  });
});
