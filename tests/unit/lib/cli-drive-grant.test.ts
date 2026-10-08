import fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TCliScope } from '@/lib/workspace-token';

// Persisted grants retain reads while all mutation paths remain local.

const scopeHolder = vi.hoisted(() => ({ scope: null as TCliScope | null, caller: null as unknown }));
const audit = vi.hoisted(() => vi.fn(async (_e: Record<string, unknown>) => {}));

vi.mock('@/lib/workspace-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-token')>()),
  resolveCliScope: () => scopeHolder.scope,
}));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: vi.fn(async (id: string) => ({ id, allowedPeers: id === 'ws-3' ? ['ws-1'] : [] })) }));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: audit }));
vi.mock('@/lib/caller', () => ({ resolveCaller: vi.fn(async () => scopeHolder.caller) }));
vi.mock('@/lib/scrum-master-access', () => ({ selectedScrumMasterCanRead: async () => false }));

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

  it('an active legacy grant permits reads but never mutations', async () => {
    await grant();
    const { canAccessWorkspace, driveDecision } = await import('@/lib/cli-utils');
    expect(await canAccessWorkspace(A_VERIFIED, 'ws-2')).toBe(true);
    expect(driveDecision(A_VERIFIED, 'ws-2')).toEqual({ ok: false, grant: null });
    expect((await input(A_VERIFIED)).status).toBe(403);
    expect((await access(A_VERIFIED, 'GET', '/api/cli/tabs/tab-x')).result).toBe(A_VERIFIED);
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
      expect((await access(A_VERIFIED, method, '/any-alias')).status).toBe(403);
      expect((await access(A_VERIFIED, method, '/any-alias', undefined, 'ws-3')).status).toBe(403);
      expect((await access(ADMIN, method, '/any-alias')).status).toBe(403);
      expect((await access(WS1, method, '/any-alias', undefined, 'ws-1')).result).toBe(WS1);
    }
    expect(audit).not.toHaveBeenCalled();
  });

  it('does not suggest replacing tokens or recreating a granted tab on denial', async () => {
    await grant();
    for (const scope of [A_VERIFIED, B_VERIFIED, A_HOOK, WS1, ADMIN]) {
      const result = await input(scope);
      expect(result).toMatchObject({ status: 403, body: { code: 'forbidden' } });
      expect(result.body.error).toContain('coordinator notes');
      expect(result.body.error).not.toMatch(/PMUX_TOKEN|recreate|allowedPeers/);
    }
    expect(audit).not.toHaveBeenCalled();
  });
});
