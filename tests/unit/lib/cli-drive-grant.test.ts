import fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TCliScope } from '@/lib/workspace-token';

// ADR-0014 / story 11: canDriveWorkspace admits a verified tab with an active
// human grant; without a grant every predicate answers as before (NFR-1).

const scopeHolder = vi.hoisted(() => ({ scope: null as TCliScope | null, caller: null as unknown }));
const audit = vi.hoisted(() => vi.fn(async (_e: Record<string, unknown>) => {}));

vi.mock('@/lib/workspace-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-token')>()),
  resolveCliScope: () => scopeHolder.scope,
}));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: vi.fn(async (id: string) => ({ id, allowedPeers: id === 'ws-3' ? ['ws-1'] : [] })) }));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: audit }));
vi.mock('@/lib/caller', () => ({ resolveCaller: vi.fn(async () => scopeHolder.caller) }));

const T0 = Date.now();
const A_VERIFIED: TCliScope = { type: 'workspace', workspaceId: 'ws-1', tabId: 'tab-a', tabVerified: true, tabIdentity: 'launch' };
const B_VERIFIED: TCliScope = { type: 'workspace', workspaceId: 'ws-1', tabId: 'tab-b', tabVerified: true, tabIdentity: 'launch' };
const A_HOOK: TCliScope = { type: 'workspace', workspaceId: 'ws-1', tabId: 'tab-a', tabIdentity: 'hook' };
const WS1: TCliScope = { type: 'workspace', workspaceId: 'ws-1' };
const ADMIN: TCliScope = { type: 'admin' };

const grant = async (over: Record<string, unknown> = {}) => {
  const { mutateGrants, createGrantInState } = await import('@/lib/grant-store');
  await mutateGrants((s) => ({
    state: createGrantInState(s, { granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-a', workspaces: ['ws-2'], reason: 'r', expiresInHours: 1, createdBy: 'human', ...over }, T0, 'g-test1').state,
    value: null,
  }));
};

const input = async (scope: TCliScope, caller: unknown = null) => {
  scopeHolder.scope = scope;
  scopeHolder.caller = caller;
  const { authorizeWorkspaceInput } = await import('@/lib/cli-utils');
  const state = { status: 0, body: undefined as unknown };
  const res = { status(c: number) { state.status = c; return this; }, json(b: unknown) { state.body = b; return this; } } as unknown as NextApiResponse;
  const result = await authorizeWorkspaceInput({ url: '/api/cli/tabs/tab-x/send?workspaceId=ws-2', query: { tabId: 'tab-x' }, headers: {} } as unknown as NextApiRequest, res, 'ws-2');
  return { result, ...state } as { result: TCliScope | null; status: number; body: { code?: string; error?: string } };
};

const access = async (scope: TCliScope, method: string, url: string, body?: unknown, ws = 'ws-2', opts: { grant?: 'allow' | 'refuse' } = {}) => {
  scopeHolder.scope = scope;
  const { authorizeWorkspace } = await import('@/lib/cli-utils');
  const state = { status: 0, body: undefined as unknown };
  const res = { status(c: number) { state.status = c; return this; }, json(b: unknown) { state.body = b; return this; } } as unknown as NextApiResponse;
  const tabId = /\/tabs\/([^/?]+)/.exec(url)?.[1];
  const result = await authorizeWorkspace({ method, url, query: tabId ? { tabId } : {}, body, headers: {} } as unknown as NextApiRequest, res, ws, opts);
  return { result, ...state } as { result: TCliScope | null; status: number; body: { code?: string; error?: string } };
};

describe('drive grants in the predicates', () => {
  beforeEach(async () => {
    const { grantsFile, reloadGrants } = await import('@/lib/grant-store');
    fs.rmSync(grantsFile(), { force: true });
    reloadGrants();
    audit.mockClear();
  });
  afterEach(async () => {
    const { grantsFile, reloadGrants } = await import('@/lib/grant-store');
    fs.rmSync(grantsFile(), { force: true });
    reloadGrants();
  });

  it('without a grant every predicate answers as before (NFR-1)', async () => {
    const { canDriveWorkspace, canAccessWorkspace, isOwnWorkspace } = await import('@/lib/cli-utils');
    for (const scope of [A_VERIFIED, A_HOOK, WS1, ADMIN]) {
      expect(canDriveWorkspace(scope, 'ws-2')).toBe(false);
      expect(await canAccessWorkspace(scope, 'ws-2')).toBe(scope.type === 'admin');
      expect(isOwnWorkspace(scope, 'ws-2')).toBe(false);
    }
    expect(canDriveWorkspace(WS1, 'ws-1')).toBe(true);
    expect(canDriveWorkspace(ADMIN, 'ws-1')).toBe(false);
  });

  it('a grant lets exactly that verified tab drive (and read) exactly the named workspace', async () => {
    await grant();
    const { canDriveWorkspace, canAccessWorkspace, driveDecision, isOwnWorkspace } = await import('@/lib/cli-utils');
    expect(driveDecision(A_VERIFIED, 'ws-2')).toMatchObject({ ok: true, grant: { id: 'g-test1' } });
    expect(await canAccessWorkspace(A_VERIFIED, 'ws-2')).toBe(true);
    expect(isOwnWorkspace(A_VERIFIED, 'ws-2')).toBe(false); // MC producer events stay own-workspace
    expect(canDriveWorkspace(A_VERIFIED, 'ws-3')).toBe(false);
    expect(canDriveWorkspace(B_VERIFIED, 'ws-2')).toBe(false);
    expect(canDriveWorkspace(A_HOOK, 'ws-2')).toBe(false);
    expect(canDriveWorkspace(WS1, 'ws-2')).toBe(false);
    expect(canDriveWorkspace(ADMIN, 'ws-2')).toBe(false);
    expect(driveDecision(A_VERIFIED, 'ws-1')).toEqual({ ok: true, grant: null });
  });

  it('an expired grant allows nothing', async () => {
    await grant({ expiresInHours: 0.0001 });
    await new Promise((r) => setTimeout(r, 400));
    const { canDriveWorkspace } = await import('@/lib/cli-utils');
    expect(canDriveWorkspace(A_VERIFIED, 'ws-2')).toBe(false);
  });

  it('authorizeWorkspaceInput: a send through a grant passes and is audited once with the route and target', async () => {
    await grant();
    const r = await input(A_VERIFIED);
    expect(r.result).toBe(A_VERIFIED);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      event: 'grant-used', grantId: 'g-test1', grantee: { workspaceId: 'ws-1', tabId: 'tab-a' },
      route: '/api/cli/tabs/tab-x/send', targetWorkspaceId: 'ws-2', targetTabId: 'tab-x',
    });
  });

  it('authorizeWorkspace: a grant-only mutation of a tab is allowed and audited once; a read is not audited (review r1)', async () => {
    await grant();
    expect((await access(A_VERIFIED, 'GET', '/api/cli/tabs/tab-x?workspaceId=ws-2')).result).toBe(A_VERIFIED);
    expect(audit).not.toHaveBeenCalled();
    expect((await access(A_VERIFIED, 'DELETE', '/api/cli/tabs/tab-x?workspaceId=ws-2')).result).toBe(A_VERIFIED);
    expect((await access(A_VERIFIED, 'POST', '/api/cli/tabs', { workspaceId: 'ws-2' })).result).toBe(A_VERIFIED);
    expect(audit.mock.calls.map(([e]) => [e.event, e.route, e.targetTabId])).toEqual([
      ['grant-used', '/api/cli/tabs/tab-x', 'tab-x'],
      ['grant-used', '/api/cli/tabs', null],
    ]);
  });

  it('authorizeWorkspace: a grant never changes a workspace\'s settings (403), and peer access is not a grant use', async () => {
    await grant();
    // The settings routes refuse by their own declaration, whatever the raw URL looks like.
    for (const route of ['/api/cli/workspaces/ws-2/orchestration', '/api/cli/tabs/../workspaces/ws-2/directories', '/weird']) {
      expect(await access(A_VERIFIED, 'PATCH', route, undefined, 'ws-2', { grant: 'refuse' })).toMatchObject({ result: null, status: 403, body: { code: 'forbidden' } });
    }
    const fs = await import('fs');
    for (const route of ['standup', 'directories', 'orchestration']) {
      const src = fs.readFileSync(`src/pages/api/cli/workspaces/[workspaceId]/${route}.ts`, 'utf-8');
      expect(src).toContain("authorizeWorkspace(req, res, workspaceId, { grant: 'refuse' })");
    }
    // ws-3 names ws-1 in allowedPeers: that access predates grants and is not audited as one.
    expect((await access(A_VERIFIED, 'DELETE', '/api/cli/tabs/tab-y?workspaceId=ws-3', undefined, 'ws-3')).result).toBe(A_VERIFIED);
    expect(audit).not.toHaveBeenCalled();
  });

  it('authorizeWorkspaceInput: a launch route names its target tab from the body', async () => {
    await grant();
    scopeHolder.scope = A_VERIFIED;
    const { authorizeWorkspaceInput } = await import('@/lib/cli-utils');
    const res = { status() { return this; }, json() { return this; } } as unknown as NextApiResponse;
    await authorizeWorkspaceInput({ url: '/api/codex/launch-command', query: {}, body: { tabId: 'tab-z' }, headers: {} } as unknown as NextApiRequest, res, 'ws-2');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'grant-used', route: '/api/codex/launch-command', targetTabId: 'tab-z' }));
  });

  it('authorizeWorkspaceInput: another tab of the grantee workspace is refused plainly (403 forbidden)', async () => {
    await grant();
    const r = await input(B_VERIFIED);
    expect(r).toMatchObject({ result: null, status: 403, body: { code: 'forbidden' } });
    expect(audit).not.toHaveBeenCalled();
  });

  it('authorizeWorkspaceInput: the grantee without its launch identity is told the grant needs a recreated tab', async () => {
    await grant();
    const hook = await input(A_HOOK);
    expect(hook).toMatchObject({ result: null, status: 403, body: { code: 'grant-tab-unverified' } });
    expect(hook.body.error).toMatch(/g-test1.*identity: hook.*recreate the tab/);
    // A pre-token tab on the session fallback: the caller names the tab.
    const session = await input(WS1, { tabId: 'tab-a', identity: 'session' });
    expect(session).toMatchObject({ status: 403, body: { code: 'grant-tab-unverified' } });
    expect(audit).not.toHaveBeenCalled();
  });
});
