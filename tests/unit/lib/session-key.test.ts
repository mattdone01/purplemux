import { describe, expect, it } from 'vitest';
import { buildSessionKey, parseSessionKey } from '@/lib/session-key';

describe('buildSessionKey', () => {
  it('uses the workspace id as scope when the session belongs to a workspace', () => {
    expect(buildSessionKey({ provider: 'claude', workspaceId: 'ws-Z-B63q', sessionId: 'abc-123' }))
      .toBe('claude:ws-Z-B63q:abc-123');
  });

  it('falls back to the global scope when there is no workspace', () => {
    expect(buildSessionKey({ provider: 'codex', workspaceId: null, sessionId: 'abc-123' }))
      .toBe('codex:global:abc-123');
  });
});

describe('parseSessionKey', () => {
  it('round-trips a workspace-scoped key', () => {
    const parts = { provider: 'claude', workspaceId: 'ws-Z-B63q', sessionId: 'abc-123' };
    expect(parseSessionKey(buildSessionKey(parts))).toEqual(parts);
  });

  it('maps the global scope back to a null workspace id', () => {
    expect(parseSessionKey('codex:global:abc-123')).toEqual({
      provider: 'codex',
      workspaceId: null,
      sessionId: 'abc-123',
    });
  });

  it('keeps colons that belong to the session id', () => {
    expect(parseSessionKey('claude:global:a:b')?.sessionId).toBe('a:b');
  });

  it('rejects keys with a missing or empty segment', () => {
    expect(parseSessionKey('claude:global')).toBeNull();
    expect(parseSessionKey('claude::abc')).toBeNull();
    expect(parseSessionKey(':global:abc')).toBeNull();
    expect(parseSessionKey('claude:global:')).toBeNull();
    expect(parseSessionKey('')).toBeNull();
  });
});
