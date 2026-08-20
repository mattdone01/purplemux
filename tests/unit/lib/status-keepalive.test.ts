import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'http';
import {
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_PING_TIMEOUT_MS,
  LONG_PING_INTERVAL_MS,
  LONG_PING_TIMEOUT_MS,
  keepaliveProfileFromRequest,
  resolveKeepaliveProfile,
} from '@/lib/status-keepalive';

const asRequest = (url: string | undefined): IncomingMessage => ({ url }) as IncomingMessage;

describe('resolveKeepaliveProfile', () => {
  it('maps "long" to the 240s/600s profile', () => {
    expect(resolveKeepaliveProfile('long')).toEqual({
      mode: 'long',
      intervalMs: LONG_PING_INTERVAL_MS,
      timeoutMs: LONG_PING_TIMEOUT_MS,
    });
    expect(LONG_PING_INTERVAL_MS).toBe(240_000);
    expect(LONG_PING_TIMEOUT_MS).toBe(600_000);
  });

  it('maps an absent value to the 30s/90s default profile', () => {
    expect(resolveKeepaliveProfile(null)).toEqual({
      mode: 'default',
      intervalMs: DEFAULT_PING_INTERVAL_MS,
      timeoutMs: DEFAULT_PING_TIMEOUT_MS,
    });
    expect(resolveKeepaliveProfile(undefined).mode).toBe('default');
    expect(DEFAULT_PING_INTERVAL_MS).toBe(30_000);
    expect(DEFAULT_PING_TIMEOUT_MS).toBe(90_000);
  });

  it('falls back to the default profile for unknown values instead of erroring', () => {
    for (const value of ['', 'LONG', 'Long', 'longer', 'short', 'true', '240', 'default']) {
      expect(resolveKeepaliveProfile(value).mode).toBe('default');
    }
  });
});

describe('keepaliveProfileFromRequest', () => {
  it('reads the keepalive query parameter of the upgrade request', () => {
    expect(keepaliveProfileFromRequest(asRequest('/api/status?keepalive=long')).mode).toBe('long');
    expect(keepaliveProfileFromRequest(asRequest('/api/status?foo=1&keepalive=long')).mode).toBe('long');
    expect(keepaliveProfileFromRequest(asRequest('/api/status')).mode).toBe('default');
    expect(keepaliveProfileFromRequest(asRequest('/api/status?keepalive=weird')).mode).toBe('default');
  });

  it('falls back to the default profile when the request or its url is missing', () => {
    expect(keepaliveProfileFromRequest(undefined).mode).toBe('default');
    expect(keepaliveProfileFromRequest(asRequest(undefined)).mode).toBe('default');
  });

  it('falls back to the default profile for an unparseable url', () => {
    expect(keepaliveProfileFromRequest(asRequest('http://[::1/api/status')).mode).toBe('default');
  });
});
