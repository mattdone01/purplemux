import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITabClosedEvent } from '@/lib/tab-lifecycle';

// ADR-0014 / story 11: a grant dies with its grantee tab — at the tab-closed
// event, and at boot for a tab that closed while the server was down.

const lifecycle = vi.hoisted(() => ({
  live: [] as Array<{ workspaceId: string; tabId: string }>,
  uncertain: new Set<string>(),
  listener: null as ((e: ITabClosedEvent) => void) | null,
}));
const audit = vi.hoisted(() => vi.fn(async (_e: Record<string, unknown>) => {}));

vi.mock('@/lib/tab-lifecycle', () => ({
  readLiveTabs: vi.fn(async () => ({ tabs: lifecycle.live, uncertainWorkspaceIds: lifecycle.uncertain })),
  onTabClosed: vi.fn((l: (e: ITabClosedEvent) => void) => {
    lifecycle.listener = l;
    return () => { lifecycle.listener = null; };
  }),
}));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: audit }));

const seed = async (grants: Array<{ id: string; ws: string; tab: string }>) => {
  const { mutateGrants, createGrantInState } = await import('@/lib/grant-store');
  await mutateGrants((s) => {
    let state = s;
    for (const g of grants) {
      state = createGrantInState(state, { granteeWorkspaceId: g.ws, granteeTabId: g.tab, workspaces: ['ws-2'], reason: 'r', expiresInHours: 1, createdBy: 'human' }, Date.now(), g.id).state;
    }
    return { state, value: null };
  });
};

const active = async () => {
  const { grantsSnapshot, isActive, reloadGrants } = await import('@/lib/grant-store');
  reloadGrants();
  return grantsSnapshot().grants.filter((g) => isActive(g, Date.now())).map((g) => g.id).sort();
};

describe('grant runtime', () => {
  beforeEach(async () => {
    const { grantsFile, reloadGrants } = await import('@/lib/grant-store');
    fs.rmSync(grantsFile(), { force: true });
    reloadGrants();
    audit.mockClear();
    lifecycle.live = [];
    lifecycle.uncertain = new Set();
  });
  afterEach(async () => {
    const { stopGrants } = await import('@/lib/grant-service');
    stopGrants();
    const { grantsFile, reloadGrants } = await import('@/lib/grant-store');
    fs.rmSync(grantsFile(), { force: true });
    reloadGrants();
  });

  it('boot: ends the grants of tabs gone while the server was down; keeps live and unknown ones', async () => {
    await seed([{ id: 'g-live1', ws: 'ws-1', tab: 'tab-a' }, { id: 'g-gone1', ws: 'ws-1', tab: 'tab-gone' }, { id: 'g-unkn1', ws: 'ws-7', tab: 'tab-x' }]);
    lifecycle.live = [{ workspaceId: 'ws-1', tabId: 'tab-a' }];
    lifecycle.uncertain = new Set(['ws-7']);
    const { startGrants } = await import('@/lib/grant-service');
    await startGrants();
    expect(await active()).toEqual(['g-live1', 'g-unkn1']);
    expect(audit).toHaveBeenCalledWith({ event: 'grant-revoked', grantId: 'g-gone1', reason: 'grantee-tab-closed', by: 'system' });
  });

  it('a tab-closed event ends that tab\'s grants within the event', async () => {
    await seed([{ id: 'g-live1', ws: 'ws-1', tab: 'tab-a' }]);
    lifecycle.live = [{ workspaceId: 'ws-1', tabId: 'tab-a' }];
    const { startGrants } = await import('@/lib/grant-service');
    await startGrants();
    expect(lifecycle.listener).not.toBeNull();
    lifecycle.listener!({ workspaceId: 'ws-1', tabId: 'tab-a', sessionName: 's', reason: 'layout-removed' } as ITabClosedEvent);
    await vi.waitFor(async () => expect(await active()).toEqual([]), { timeout: 5000 });
  });
});
