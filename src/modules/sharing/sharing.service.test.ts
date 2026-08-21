import { describe, expect, it } from 'vitest';
import { isSharingAllowed, toShareView } from './sharing.service.js';
import { defaultOrganizationSettings } from '../organizations/organizations.types.js';

/**
 * Sharing policy enforcement.
 *
 * Only public links can leave the tenant boundary; direct user/team shares
 * are restricted to contacts instead (see `searchEligibleUsers`), so the
 * workspace policy only ever gates `principalType === 'link'`.
 */
describe('isSharingAllowed', () => {
  it('never restricts direct user shares, regardless of policy', () => {
    expect(isSharingAllowed(defaultOrganizationSettings, 'user')).toEqual({ allowed: true });
    expect(isSharingAllowed(defaultOrganizationSettings, 'team')).toEqual({ allowed: true });
  });

  it('allows link shares once the workspace opts in to external sharing', () => {
    const settings = { ...defaultOrganizationSettings, allowExternalSharing: true };
    expect(isSharingAllowed(settings, 'link')).toEqual({ allowed: true });
  });

  it('blocks link shares under the default restrict policy', () => {
    const result = isSharingAllowed(defaultOrganizationSettings, 'link');
    expect(result.allowed).toBe(false);
    expect(result.message).toBe(defaultOrganizationSettings.sharingPolicy.warningMessage);
  });

  it('allows link shares when the policy mode is not "restrict"', () => {
    const settings = {
      ...defaultOrganizationSettings,
      sharingPolicy: { ...defaultOrganizationSettings.sharingPolicy, mode: 'warn' as const },
    };
    expect(isSharingAllowed(settings, 'link')).toEqual({ allowed: true });
  });
});

describe('toShareView', () => {
  const baseRow = {
    id: 'share-1',
    file_id: 'file-1',
    principal_type: 'user' as const,
    principal_id: 'user-2',
    principal_name: 'Mukesh Kumar',
    principal_username: 'mukesh',
    role: 'viewer' as const,
    message: null,
    expires_at: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    shared_by: 'user-1',
  };

  it('maps a share row to its public view', () => {
    expect(toShareView(baseRow)).toEqual({
      id: 'share-1',
      fileId: 'file-1',
      principalType: 'user',
      principalId: 'user-2',
      principalName: 'Mukesh Kumar',
      principalUsername: 'mukesh',
      role: 'viewer',
      message: null,
      expiresAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      sharedBy: 'user-1',
    });
  });

  it('formats an expiry date as ISO when present', () => {
    const view = toShareView({ ...baseRow, expires_at: new Date('2026-02-01T00:00:00.000Z') });
    expect(view.expiresAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('has no principal name or username for a public link', () => {
    const view = toShareView({
      ...baseRow,
      principal_type: 'link',
      principal_id: null,
      principal_name: null,
      principal_username: null,
    });
    expect(view.principalType).toBe('link');
    expect(view.principalId).toBeNull();
    expect(view.principalName).toBeNull();
    expect(view.principalUsername).toBeNull();
  });
});
