import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeGrantFailure, grantBadgeOf, grantErrorKey } from '@/lib/grant-view';
import { createGrantRequest, fetchGrantsView, revokeGrantRequest } from '@/lib/grants-client';
import type { IGrant } from '@/types/grant';

// Story 28: the badge data, the error label for each refusal, and the client
// keeping the served reason.

const NOW = Date.parse('2026-09-26T14:00:00Z');
const grant = (over: Partial<IGrant>): IGrant => ({
  id: 'g-1', capability: 'drive', grantee: { workspaceId: 'ws-1', tabId: 'tab-a' }, workspaces: ['ws-2'], reason: 'r',
  createdAt: NOW - 1, createdBy: 'human', expiresAt: NOW + 3_600_000, revokedAt: null, revokedBy: null, revokeReason: null, expiryNotedAt: null,
  ...over,
});

describe('grantBadgeOf', () => {
  it('counts the distinct workspaces of a tab\'s active grants and keeps the latest expiry', () => {
    const grants = [
      grant({ id: 'g-1', workspaces: ['ws-2', 'ws-3'], expiresAt: NOW + 1000 }),
      grant({ id: 'g-2', workspaces: ['ws-3', 'ws-4'], expiresAt: NOW + 5000 }),
      grant({ id: 'g-3', workspaces: ['ws-9'], revokedAt: NOW - 1 }),
      grant({ id: 'g-4', workspaces: ['ws-8'], expiresAt: NOW }),
      grant({ id: 'g-5', grantee: { workspaceId: 'ws-1', tabId: 'tab-b' }, workspaces: ['ws-7'] }),
    ];
    expect(grantBadgeOf(grants, 'ws-1', 'tab-a', NOW)).toEqual({ count: 3, workspaces: ['ws-2', 'ws-3', 'ws-4'], expiresAt: NOW + 5000 });
  });

  it('is null for a tab without an active grant (revoked or expired ones do not count)', () => {
    expect(grantBadgeOf([grant({ revokedAt: NOW - 1 })], 'ws-1', 'tab-a', NOW)).toBeNull();
    expect(grantBadgeOf([grant({ expiresAt: NOW })], 'ws-1', 'tab-a', NOW)).toBeNull();
    expect(grantBadgeOf([], 'ws-1', 'tab-a', NOW)).toBeNull();
  });
});

describe('the dialog\'s refusal text (AC: each state shows the served reason)', () => {
  const label = (key: string, values?: Record<string, string | number>) => (values ? `${key}(${JSON.stringify(values)})` : key);
  it.each([
    [403, 'grant-password-invalid', 'errorPassword'],
    [429, 'grant-locked', 'errorLocked'],
    [401, 'unauthorized', 'errorSession'],
    [403, 'forbidden', 'errorOrigin'],
    [409, 'grant-tab-unverified', 'errorUnverified'],
    [400, 'grant-invalid', 'errorInvalid'],
    [404, 'grant-not-found', 'errorNotFound'],
    [500, 'grant-store-unreadable', 'errorStore'],
    [0, null, 'errorNetwork'],
  ])('%s %s → %s, followed by the served reason', (status, code, key) => {
    expect(grantErrorKey(status, code)).toBe(key);
    expect(describeGrantFailure({ status, code, reason: 'the server said why' }, label)).toBe(`${key}: the server said why`);
  });

  it('an unknown code names the status and never shows the raw code', () => {
    expect(describeGrantFailure({ status: 502, code: 'weird-code', reason: null }, label)).toBe('errorUnknown({"status":502})');
  });
});

describe('grants client', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300, status, json: async () => body,
  })));

  it('returns the served code and reason for a refusal', async () => {
    respond(403, { error: 'the purplemux password is wrong or missing', code: 'grant-password-invalid' });
    expect(await createGrantRequest({ granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-a', workspaces: ['ws-2'], reason: 'r', expiresInHours: 24, password: 'x' }))
      .toEqual({ ok: false, status: 403, code: 'grant-password-invalid', reason: 'the purplemux password is wrong or missing' });
  });

  it('reads grants and grantees, and revokes by encoded id', async () => {
    respond(200, { grants: [grant({})], grantees: [{ workspaceId: 'ws-1', workspaceName: 'one', tabId: 'tab-a', name: 'a', panelType: 'claude-code', identity: 'launch' }] });
    const view = await fetchGrantsView();
    expect(view.ok && view.value.grantees[0].identity).toBe('launch');
    respond(200, { grant: grant({ revokedAt: NOW }) });
    await revokeGrantRequest('g-1');
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['/api/grants/g-1', { method: 'DELETE' }]);
  });

  it('a network failure is status 0 with its message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchGrantsView()).toEqual({ ok: false, status: 0, code: null, reason: 'offline' });
  });
});
