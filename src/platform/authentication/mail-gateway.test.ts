import { describe, expect, it } from 'vitest';
import { evaluateGatewayRequest, tokenMatches } from './mail-gateway.js';

/**
 * Regression cover for TASK-003.
 *
 * Before this guard existed, POST /api/v1/mail/receive accepted a message from
 * anyone who could reach the API, with a fully attacker-chosen `from` address.
 * These cases pin the decision so the endpoint cannot drift back open.
 */
describe('tokenMatches', () => {
  it('accepts an exact match', () => {
    expect(tokenMatches('s3cret-token', 's3cret-token')).toBe(true);
  });

  it('rejects a different token of the same length', () => {
    expect(tokenMatches('aaaaaaaaaaaa', 'bbbbbbbbbbbb')).toBe(false);
  });

  it('rejects a prefix of the real token', () => {
    expect(tokenMatches('s3cret', 's3cret-token')).toBe(false);
  });

  it('rejects when either side is absent', () => {
    expect(tokenMatches(undefined, 's3cret-token')).toBe(false);
    expect(tokenMatches('s3cret-token', undefined)).toBe(false);
    expect(tokenMatches(undefined, undefined)).toBe(false);
  });

  it('rejects the empty string against a configured token', () => {
    expect(tokenMatches('', 's3cret-token')).toBe(false);
  });

  it('does not throw on a length mismatch', () => {
    // timingSafeEqual throws on unequal buffer lengths; the guard must absorb
    // that rather than turning an attacker-controlled header into a 500.
    expect(() => tokenMatches('a', 'a-much-longer-token')).not.toThrow();
  });
});

describe('evaluateGatewayRequest', () => {
  const expected = 'gateway-secret-value';

  it('allows a request carrying the configured token', () => {
    expect(evaluateGatewayRequest({ presented: expected, expected, production: true })).toEqual({
      allowed: true,
      reason: 'ok',
    });
  });

  it('rejects a request with no token in production', () => {
    expect(evaluateGatewayRequest({ presented: undefined, expected, production: true })).toEqual({
      allowed: false,
      reason: 'missing-token',
    });
  });

  it('rejects a request with the wrong token in production', () => {
    expect(evaluateGatewayRequest({ presented: 'guessed', expected, production: true })).toEqual({
      allowed: false,
      reason: 'bad-token',
    });
  });

  it('rejects a request with the wrong token in development too', () => {
    // Development relaxes only the *unconfigured* case. Once a token is set,
    // a wrong one is always a rejection.
    expect(evaluateGatewayRequest({ presented: 'guessed', expected, production: false })).toEqual({
      allowed: false,
      reason: 'bad-token',
    });
  });

  it('refuses delivery in production when no token is configured', () => {
    // Boot should already have failed; this is the second line of defence.
    expect(evaluateGatewayRequest({ presented: 'anything', expected: undefined, production: true })).toEqual({
      allowed: false,
      reason: 'missing-token',
    });
  });

  it('allows delivery in development when no token is configured', () => {
    // A fresh checkout can receive mail without ceremony; the caller warns.
    expect(
      evaluateGatewayRequest({ presented: undefined, expected: undefined, production: false }),
    ).toEqual({ allowed: true, reason: 'unconfigured-development' });
  });
});
