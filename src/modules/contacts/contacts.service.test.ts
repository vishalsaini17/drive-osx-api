import { describe, expect, it } from 'vitest';
import { PRESENCE_TTL_SECONDS, effectivePresence } from './contacts.service.js';

/**
 * Presence decay.
 *
 * The stored row cannot be trusted on its own: a browser that is closed,
 * crashes or loses its network never gets to write `offline`, so a naive read
 * shows that user as online forever. Contacts would then display connection
 * status that is simply wrong, which is worse than showing nothing.
 */
describe('effectivePresence', () => {
  const now = new Date('2026-08-13T12:00:00.000Z');
  const secondsAgo = (seconds: number) => new Date(now.getTime() - seconds * 1000);

  it('reports a recent heartbeat at its stored status', () => {
    expect(effectivePresence({ status: 'online', lastSeenAt: secondsAgo(5), now })).toBe('online');
  });

  it('preserves non-online statuses while the heartbeat is fresh', () => {
    expect(effectivePresence({ status: 'away', lastSeenAt: secondsAgo(10), now })).toBe('away');
    expect(effectivePresence({ status: 'busy', lastSeenAt: secondsAgo(10), now })).toBe('busy');
    expect(effectivePresence({ status: 'dnd', lastSeenAt: secondsAgo(10), now })).toBe('dnd');
  });

  it('holds status right up to the TTL boundary', () => {
    expect(
      effectivePresence({ status: 'online', lastSeenAt: secondsAgo(PRESENCE_TTL_SECONDS), now }),
    ).toBe('online');
  });

  it('decays to offline once the heartbeat is older than the TTL', () => {
    expect(
      effectivePresence({ status: 'online', lastSeenAt: secondsAgo(PRESENCE_TTL_SECONDS + 1), now }),
    ).toBe('offline');
  });

  it('decays a user who closed the tab hours ago', () => {
    expect(effectivePresence({ status: 'online', lastSeenAt: secondsAgo(7200), now })).toBe('offline');
  });

  it('decays away/busy too, not just online', () => {
    expect(effectivePresence({ status: 'away', lastSeenAt: secondsAgo(3600), now })).toBe('offline');
    expect(effectivePresence({ status: 'dnd', lastSeenAt: secondsAgo(3600), now })).toBe('offline');
  });

  it('treats a user with no presence row as offline', () => {
    expect(effectivePresence({ status: null, lastSeenAt: null, now })).toBe('offline');
  });

  it('treats a stored offline status as offline however fresh', () => {
    expect(effectivePresence({ status: 'offline', lastSeenAt: secondsAgo(1), now })).toBe('offline');
  });

  it('treats a missing timestamp as offline even with a live status', () => {
    expect(effectivePresence({ status: 'online', lastSeenAt: null, now })).toBe('offline');
  });

  it('accepts an ISO string as well as a Date', () => {
    expect(
      effectivePresence({ status: 'online', lastSeenAt: secondsAgo(5).toISOString(), now }),
    ).toBe('online');
  });

  it('treats an unparseable timestamp as offline rather than throwing', () => {
    expect(effectivePresence({ status: 'online', lastSeenAt: 'not-a-date', now })).toBe('offline');
  });

  it('does not treat clock skew as absence', () => {
    // A timestamp slightly in the future means the two clocks disagree, not
    // that the user left. Negative age is inside the TTL, so status holds.
    expect(effectivePresence({ status: 'online', lastSeenAt: secondsAgo(-30), now })).toBe('online');
  });
});
