import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortfolioStore } from '@/lib/portfolio-store';
import type { TCliScope } from '@/lib/workspace-token';

const state = vi.hoisted(() => ({
  scope: null as TCliScope | null,
  currentTab: 'tab-root',
  live: true,
  identity: 'launch',
}));

vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: () => state.scope }));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: async (id: string) => ({ id, orchestration: {
    enabled: true, orchestratorTabId: id === 'ws-root' ? state.currentTab : `tab-${id}`,
  }, allowedPeers: [] }),
  getWorkspaces: async () => ({ workspaces: ['ws-root', 'ws-a', 'ws-b'].map((id) => ({ id, name: id,
    directories: ['/repo'], orchestration: { enabled: true, orchestratorTabId: id === 'ws-root' ? state.currentTab : `tab-${id}` } })) }),
}));
vi.mock('@/lib/layout-store', () => ({
  resolveLayoutFile: (id: string) => id,
  readLayoutFile: async (id: string) => ({ root: { id } }),
  collectAllTabs: (root: { id: string }) => [{ id: root.id === 'ws-root' ? state.currentTab : `tab-${root.id}`,
    sessionName: `session-${root.id}` }],
  getLayout: vi.fn(),
}));
vi.mock('@/lib/tab-token', () => ({ tabIdentityOf: () => state.identity }));
vi.mock('@/lib/tmux', () => ({ hasSession: async () => state.live }));
vi.mock('@/lib/grant-store', () => ({ grantsSnapshot: () => ({ grants: [] }), findActiveDriveGrant: () => null }));
vi.mock('@/lib/portfolio-service', () => ({ getPortfolioSnapshotForSelection: vi.fn(async (selection: unknown) => ({ selection })) }));
vi.mock('@/lib/mission-control-runtime', () => ({ getMissionSnapshot: async () => ({ schemaVersion: 1, cursor: 0 }) }));
vi.mock('@/lib/mission-control-store', () => ({ getMissionControlStore: () => ({ humanInboxPolicy: () => ({ version: 1 }) }) }));
vi.mock('@/lib/caller', () => ({ resolveCaller: async () => state.scope && state.scope.type === 'workspace'
  ? { scope: state.scope, workspaceId: state.scope.workspaceId, tabId: state.scope.tabId ?? null,
    verified: state.scope.tabVerified === true } : null }));

const manager: TCliScope = { type: 'workspace', workspaceId: 'ws-root', tabId: 'tab-root', tabVerified: true };
const response = () => {
  const out = { status: 0, body: null as unknown };
  const res = { setHeader() { return this; }, status(value: number) { out.status = value; return this; },
    json(value: unknown) { out.body = value; return this; } } as unknown as NextApiResponse;
  return { out, res };
};

describe('human-selected Scrum Master read scope', () => {
  let store: PortfolioStore;
  beforeEach(() => {
    store = new PortfolioStore(':memory:');
    (globalThis as { __ptPortfolioStore?: PortfolioStore }).__ptPortfolioStore = store;
    state.scope = manager;
    state.currentTab = 'tab-root';
    state.live = true;
    state.identity = 'launch';
    store.select('human-a', { managerWorkspaceId: 'ws-root', managerTabId: 'tab-root', workspaceIds: ['ws-a'] });
  });
  afterEach(() => {
    store.close();
    delete (globalThis as { __ptPortfolioStore?: PortfolioStore }).__ptPortfolioStore;
  });

  it('permits selected workspace and tab reads with zero grants, but no foreign writes', async () => {
    const { accessDecision, authorizeWorkspace } = await import('@/lib/cli-utils');
    expect((await accessDecision(manager, 'ws-a')).ok).toBe(true);
    expect((await accessDecision(manager, 'ws-b')).ok).toBe(false);
    const get = response();
    expect(await authorizeWorkspace({ method: 'GET', headers: {} } as NextApiRequest, get.res, 'ws-a')).toEqual(manager);
    const post = response();
    expect(await authorizeWorkspace({ method: 'POST', headers: {} } as NextApiRequest, post.res, 'ws-a')).toBeNull();
    expect(post.out.status).toBe(403);
  });

  it('rejects other, unverified, reassigned and closed manager tabs immediately', async () => {
    const { accessDecision } = await import('@/lib/cli-utils');
    expect((await accessDecision({ ...manager, tabId: 'tab-other' }, 'ws-a')).ok).toBe(false);
    expect((await accessDecision({ ...manager, tabVerified: undefined }, 'ws-a')).ok).toBe(false);
    expect((await accessDecision({ ...manager, workspaceId: 'ws-other' }, 'ws-a')).ok).toBe(false);
    state.identity = 'hook';
    expect((await accessDecision(manager, 'ws-a')).ok).toBe(false);
    state.identity = 'launch';
    state.live = false;
    expect((await accessDecision(manager, 'ws-a')).ok).toBe(false);
    state.live = true;
    state.currentTab = 'tab-reassigned';
    expect((await accessDecision(manager, 'ws-a')).ok).toBe(false);
    state.currentTab = 'tab-root';
    store.select('human-b', { managerWorkspaceId: 'ws-root', managerTabId: 'tab-root', workspaceIds: ['ws-b'] });
    expect((await accessDecision(manager, 'ws-a')).ok).toBe(false);
    expect((await accessDecision(manager, 'ws-b')).ok).toBe(true);
  });

  it('lists only selected workspace reads and refuses CLI portfolio scope expansion', async () => {
    const { default: workspaces } = await import('@/pages/api/cli/workspaces');
    const listing = response();
    await workspaces({ method: 'GET', headers: {} } as NextApiRequest, listing.res);
    expect(listing.out.body).toEqual({ workspaces: [
      { id: 'ws-root', name: 'ws-root', directories: ['/repo'] },
      { id: 'ws-a', name: 'ws-a', directories: ['/repo'] },
    ] });

    const { default: portfolio } = await import('@/pages/api/cli/portfolio');
    const allowed = response();
    await portfolio({ method: 'GET', headers: {}, query: { workspaces: 'ws-root,ws-a' } } as unknown as NextApiRequest, allowed.res);
    expect(allowed.out.status).toBe(200);
    const denied = response();
    await portfolio({ method: 'GET', headers: {}, query: { workspaces: 'ws-a,ws-b' } } as unknown as NextApiRequest, denied.res);
    expect(denied.out.status).toBe(403);
    const mutation = response();
    await portfolio({ method: 'POST', headers: {}, query: { workspaces: 'ws-a' } } as unknown as NextApiRequest, mutation.res);
    expect(mutation.out.status).toBe(405);
  });

  it('applies selection removal to the ordinary Mission Control read route', async () => {
    const { default: mission } = await import('@/pages/api/cli/mission-control');
    const allowed = response();
    await mission({ method: 'GET', headers: {}, query: { workspaceId: 'ws-a' } } as unknown as NextApiRequest, allowed.res);
    expect(allowed.out.status).toBe(200);
    store.select('human-b', { managerWorkspaceId: 'ws-root', managerTabId: 'tab-root', workspaceIds: [] });
    const denied = response();
    await mission({ method: 'GET', headers: {}, query: { workspaceId: 'ws-a' } } as unknown as NextApiRequest, denied.res);
    expect(denied.out.status).toBe(403);
  });
});
