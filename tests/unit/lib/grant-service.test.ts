import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkStepUp,
  createGrant,
  resetStepUp,
  revokeForClosedTab,
  revokeGrant,
  STEP_UP_LOCK_MS,
  sweepGrants,
  type IGrantDeps,
} from '@/lib/grant-service';
import { findActiveDriveGrant, grantsFile, grantsSnapshot, isGrantError, reloadGrants } from '@/lib/grant-store';

// ADR-0014 / story 11: the step-up password and its lockout, the grant rules, the audits.

const T0 = Date.parse('2026-09-26T12:00:00Z');
const H = 60 * 60 * 1000;

const deps = (over: Partial<IGrantDeps> = {}) => {
  const audit = vi.fn(async (_e: Record<string, unknown>) => {});
  const clock = { now: T0 };
  const d: IGrantDeps = {
    now: () => clock.now,
    passwordHash: async () => 'scrypt:hash',
    verifyPassword: async (plain) => plain === 'right',
    workspaceExists: async (ws) => ['ws-1', 'ws-2', 'ws-3'].includes(ws),
    tabExists: async (ws, tab) => ws === 'ws-1' && ['tab-a', 'tab-old'].includes(tab),
    tabIdentity: (_ws, tab) => (tab === 'tab-a' ? 'launch' : 'hook'),
    audit,
    ...over,
  };
  return { d, audit, clock };
};

const request = (over: Record<string, unknown> = {}) => ({
  granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-a', workspaces: ['ws-2'], reason: 'portfolio run', password: 'right', ...over,
});

const code = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e) => e);
  return isGrantError(err) ? err.code : err;
};

describe('grant service', () => {
  beforeEach(() => {
    fs.rmSync(grantsFile(), { force: true });
    reloadGrants();
    resetStepUp();
  });
  afterEach(() => {
    fs.rmSync(grantsFile(), { force: true });
    reloadGrants();
  });

  it('creates a 24 h grant for a launch-verified tab and audits it', async () => {
    const { d, audit } = deps();
    const grant = await createGrant(d, 'human', request());
    expect(grant).toMatchObject({ grantee: { workspaceId: 'ws-1', tabId: 'tab-a' }, workspaces: ['ws-2'], createdBy: 'human', expiresAt: T0 + 24 * H });
    expect(findActiveDriveGrant(grantsSnapshot(), grant.grantee, 'ws-2', T0 + 1)?.id).toBe(grant.id);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'grant-created', grantId: grant.id, by: 'human' }));
  });

  it('refuses a tab without a launch identity (hook or none): grant-tab-unverified', async () => {
    const { d } = deps();
    expect(await code(createGrant(d, 'human', request({ granteeTabId: 'tab-old' })))).toBe('grant-tab-unverified');
    expect(grantsSnapshot().grants).toEqual([]);
  });

  it.each([
    ['its own workspace', { workspaces: ['ws-1'] }],
    ['no workspace', { workspaces: [] }],
    ['an unknown workspace', { workspaces: ['ws-9'] }],
    ['an unknown tab', { granteeTabId: 'tab-zz' }],
    ['no reason', { reason: ' ' }],
    ['more than 7 days', { expiresInHours: 169 }],
    ['zero hours', { expiresInHours: 0 }],
  ])('refuses %s: grant-invalid', async (_label, over) => {
    const { d } = deps();
    expect(await code(createGrant(d, 'human', request(over)))).toBe('grant-invalid');
  });

  it('a wrong or missing password is refused and audited; 5 in 10 min lock the route for 15 min', async () => {
    const { d, audit, clock } = deps();
    for (const password of ['wrong', undefined, '', 'nope']) {
      expect(await code(createGrant(d, 'human', request({ password })))).toBe('grant-password-invalid');
    }
    expect(audit).toHaveBeenCalledWith({ event: 'grant-password-invalid', action: 'create', by: 'human', locked: false });
    expect(await code(createGrant(d, 'human', request({ password: 'fifth' })))).toBe('grant-password-invalid');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'grant-locked' }));
    // Locked: even the right password is refused until the lock ends.
    expect(await code(createGrant(d, 'human', request()))).toBe('grant-locked');
    clock.now += STEP_UP_LOCK_MS + 1;
    expect(await code(createGrant(d, 'human', request()))).toBe(null);
  });

  it('a burst of concurrent wrong guesses reaches the password check at most 5 times (review r1)', async () => {
    const verify = vi.fn(async (plain: string) => plain === 'right');
    const { d } = deps({ verifyPassword: verify });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => code(createGrant(d, 'human', request({ password: `guess-${i}` })))));
    expect(verify).toHaveBeenCalledTimes(5);
    expect(results.filter((r) => r === 'grant-password-invalid')).toHaveLength(5);
    expect(results.filter((r) => r === 'grant-locked')).toHaveLength(7);
  });

  it('the lockout never blocks revoking: revoke needs the session, not the password', async () => {
    const { d } = deps();
    const grant = await createGrant(d, 'human', request());
    for (let i = 0; i < 5; i++) await createGrant(d, 'human', request({ password: 'wrong' })).catch(() => {});
    expect(await code(createGrant(d, 'human', request()))).toBe('grant-locked');
    expect(await revokeGrant(d, 'human', grant.id)).toMatchObject({ revokeReason: 'revoked' });
  });

  it('a tab that closes between the check and the write leaves no active grant', async () => {
    let calls = 0;
    const { d, audit } = deps({ tabExists: async () => (calls++ === 0) });
    expect(await code(createGrant(d, 'human', request()))).toBe('grant-invalid');
    const { isActive } = await import('@/lib/grant-store');
    expect(grantsSnapshot().grants.filter((g) => isActive(g, T0 + 1))).toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'grant-revoked', reason: 'grantee-tab-closed' }));
  });

  it('failures older than 10 minutes do not count toward the lock', async () => {
    const { d, clock } = deps();
    for (let i = 0; i < 4; i++) await checkStepUp(d, 'human', 'wrong', 'create').catch(() => {});
    clock.now += 11 * 60 * 1000;
    await checkStepUp(d, 'human', 'wrong', 'create').catch(() => {});
    expect(await code(checkStepUp(d, 'human', 'right', 'create'))).toBe(null);
  });

  it('refuses when no password is set at all', async () => {
    const { d } = deps({ passwordHash: async () => null });
    expect(await code(createGrant(d, 'human', request()))).toBe('grant-password-invalid');
  });

  it('revoke is audited once; a second revoke changes nothing; unknown ids are not found', async () => {
    const { d, audit, clock } = deps();
    const grant = await createGrant(d, 'human', request());
    clock.now += H;
    expect(await revokeGrant(d, 'human', grant.id)).toMatchObject({ revokedAt: T0 + H, revokeReason: 'revoked', revokedBy: 'human' });
    await revokeGrant(d, 'human', grant.id);
    expect(audit.mock.calls.filter(([e]) => e.event === 'grant-revoked')).toHaveLength(1);
    expect(await code(revokeGrant(d, 'human', 'g-nosuch1'))).toBe('grant-not-found');
    expect(await code(revokeGrant(d, 'human', '../etc'))).toBe('grant-not-found');
  });

  it('a closed grantee tab ends its grants (grantee-tab-closed); expiry is audited once', async () => {
    const { d, audit, clock } = deps();
    const a = await createGrant(d, 'human', request());
    const b = await createGrant(d, 'human', request({ expiresInHours: 1 }));
    const revoked = await revokeForClosedTab(d, { workspaceId: 'ws-1', tabId: 'tab-a' });
    expect(revoked.map((g) => g.id).sort()).toEqual([a.id, b.id].sort());
    expect(audit).toHaveBeenCalledWith({ event: 'grant-revoked', grantId: a.id, reason: 'grantee-tab-closed', by: 'system' });
    const c = await createGrant(d, 'human', request({ expiresInHours: 1 }));
    clock.now += 2 * H;
    expect((await sweepGrants(d)).map((g) => g.id)).toEqual([c.id]);
    expect(await sweepGrants(d)).toEqual([]);
    expect(audit.mock.calls.filter(([e]) => e.event === 'grant-expired')).toHaveLength(1);
  });
});
