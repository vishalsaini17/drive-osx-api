import { describe, expect, it } from 'vitest';
import { slugify } from './organizations.service.js';
import { defaultOrganizationSettings, toOrganizationView, type OrganizationRow } from './organizations.types.js';

describe('slugify', () => {
  it('produces a URL-safe workspace address', () => {
    expect(slugify('Acme Corporation')).toBe('acme-corporation');
    expect(slugify("Vishal's Workspace")).toBe('vishal-s-workspace');
    expect(slugify('  Trimmed  ')).toBe('trimmed');
  });

  it('collapses runs of separators and strips leading/trailing dashes', () => {
    expect(slugify('a---b')).toBe('a-b');
    expect(slugify('!!! hello !!!')).toBe('hello');
  });

  it('falls back to a default when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('workspace');
    expect(slugify('')).toBe('workspace');
  });

  it('caps the length so the slug stays index friendly', () => {
    expect(slugify('a'.repeat(120)).length).toBeLessThanOrEqual(48);
  });
});

describe('toOrganizationView', () => {
  const row: OrganizationRow = {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    type: 'organization',
    owner_id: 'user-1',
    settings: null,
    storage_quota_bytes: '1000',
    storage_used_bytes: '250',
    is_active: true,
    created_at: new Date('2025-01-01T00:00:00Z'),
    updated_at: new Date('2025-01-02T00:00:00Z'),
  };

  it('applies safe defaults when settings have never been written', () => {
    const view = toOrganizationView(row);
    expect(view.settings).toEqual(defaultOrganizationSettings);
    expect(view.settings.allowExternalSharing).toBe(false);
  });

  it('merges partial stored settings over the defaults', () => {
    const view = toOrganizationView({
      ...row,
      settings: { allowExternalSharing: true, sharingPolicy: { mode: 'warn' } as never },
    });
    expect(view.settings.allowExternalSharing).toBe(true);
    expect(view.settings.sharingPolicy.mode).toBe('warn');
    // Untouched fields keep their defaults rather than becoming undefined.
    expect(view.settings.sharingPolicy.warningMessage).toBe(
      defaultOrganizationSettings.sharingPolicy.warningMessage,
    );
  });

  it('converts bigint columns to numbers and keeps the legacy _id alias', () => {
    const view = toOrganizationView(row);
    expect(view.storage).toEqual({ quotaBytes: 1000, usedBytes: 250 });
    expect(view._id).toBe(view.id);
  });
});
