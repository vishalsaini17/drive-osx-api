import { describe, expect, it } from 'vitest';
import { parseRawMessage } from './mail.service.js';

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
