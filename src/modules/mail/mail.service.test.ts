import { describe, expect, it } from 'vitest';
import { buildRawMessage, isLocalDomain, parseRawMessage, splitAddresses } from './mail.service.js';

describe('parseRawMessage', () => {
  const raw = [
    'From: Alice <alice@example.com>',
    'To: bob@driveosx.com',
    'Subject: Quarterly report',
    'Date: Tue, 12 Aug 2025 10:30:00 +0000',
    '',
    'Here is the report you asked for.',
  ].join('\r\n');

  it('extracts the headers the mailbox needs', () => {
    const parsed = parseRawMessage(raw);
    expect(parsed.from).toBe('Alice <alice@example.com>');
    expect(parsed.to).toBe('bob@driveosx.com');
    expect(parsed.subject).toBe('Quarterly report');
    expect(parsed.sentAt).toBe('2025-08-12T10:30:00.000Z');
  });

  it('separates the body from the headers', () => {
    expect(parseRawMessage(raw).body).toBe('Here is the report you asked for.');
  });

  it('handles bare-LF messages as well as CRLF', () => {
    const parsed = parseRawMessage('Subject: Hello\n\nBody text');
    expect(parsed.subject).toBe('Hello');
    expect(parsed.body).toBe('Body text');
  });

  it('matches header names case-insensitively', () => {
    expect(parseRawMessage('subject: lowercase header\n\nbody').subject).toBe('lowercase header');
  });

  it('falls back to now for a missing or unparseable date', () => {
    const before = Date.now();
    const parsed = parseRawMessage('Subject: No date\n\nbody');
    expect(new Date(parsed.sentAt).getTime()).toBeGreaterThanOrEqual(before - 1000);

    const bad = parseRawMessage('Date: not-a-real-date\n\nbody');
    expect(Number.isNaN(new Date(bad.sentAt).getTime())).toBe(false);
  });

  it('returns empty strings rather than throwing on a message with no headers', () => {
    const parsed = parseRawMessage('just some text');
    expect(parsed.from).toBe('');
    expect(parsed.subject).toBe('');
    expect(parsed.body).toBe('just some text');
  });
});

describe('splitAddresses', () => {
  it('splits comma and semicolon separated recipients', () => {
    expect(splitAddresses('alice@example.com, bob@example.com; carol@example.com')).toEqual([
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
    ]);
  });

  it('extracts the bare address from a display-name form and lowercases it', () => {
    expect(splitAddresses('Alice <Alice@Example.com>')).toEqual(['alice@example.com']);
  });

  it('ignores blank entries and returns an empty array for nothing', () => {
    expect(splitAddresses('alice@example.com,, ,bob@example.com')).toEqual(['alice@example.com', 'bob@example.com']);
    expect(splitAddresses('')).toEqual([]);
    expect(splitAddresses(undefined)).toEqual([]);
    expect(splitAddresses(null)).toEqual([]);
  });
});

describe('isLocalDomain', () => {
  it('is true for the platform mail domain', () => {
    expect(isLocalDomain('bob@driveosx.com')).toBe(true);
  });

  it('is false for any other domain', () => {
    expect(isLocalDomain('bob@example.com')).toBe(false);
  });

  it('is false for an address with no domain', () => {
    expect(isLocalDomain('not-an-address')).toBe(false);
  });
});

describe('buildRawMessage', () => {
  const baseEmail = {
    id: 'email-1',
    user_id: 'user-1',
    message_id: '<fixed-id@driveosx.com>',
    from_address: 'alice@driveosx.com',
    to_address: 'bob@example.com',
    cc_address: null,
    bcc_address: null,
    subject: 'Quarterly report',
    body: 'Plain text body',
    body_html: null,
    folder: 'sent' as const,
    is_unread: false,
    is_starred: false,
    is_pinned: false,
    is_important: false,
    labels: [],
    attachments: [],
    sent_at: new Date('2025-01-01T00:00:00Z'),
    created_at: new Date('2025-01-01T00:00:00Z'),
  };

  it('builds a plain-text message when there is no HTML body', async () => {
    const raw = await buildRawMessage(baseEmail, 'bob@example.com');
    expect(raw).toContain('From: alice@driveosx.com');
    expect(raw).toContain('To: bob@example.com');
    expect(raw).toContain('Subject: Quarterly report');
    expect(raw).toContain('Message-ID: <fixed-id@driveosx.com>');
    expect(raw).toContain('Content-Type: text/plain');
    expect(raw).toContain('Plain text body');
    expect(raw).not.toContain('multipart');
  });

  it('wraps text and HTML bodies as multipart/alternative when both are present', async () => {
    const raw = await buildRawMessage({ ...baseEmail, body_html: '<p>Plain text body</p>' }, 'bob@example.com');
    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(raw).toContain('Content-Type: text/plain');
    expect(raw).toContain('Content-Type: text/html');
    expect(raw).toContain('<p>Plain text body</p>');
  });

  it('omits attachments that have no stored bytes rather than referencing missing content', async () => {
    const raw = await buildRawMessage(
      { ...baseEmail, attachments: [{ id: 'a1', name: 'notes.txt', size: '10', type: 'text/plain' }] },
      'bob@example.com',
    );
    expect(raw).not.toContain('multipart/mixed');
    expect(raw).not.toContain('notes.txt');
  });
});
