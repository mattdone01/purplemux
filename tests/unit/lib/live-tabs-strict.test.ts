import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILeaseHolder } from '@/types/lease';
import { drainLeaseLocks, makeHome, resetLeaseGlobals } from './lease-test-home';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});
vi.mock('@/lib/tmux', () => ({
  createSession: vi.fn(async () => {}),
  hasSession: vi.fn(async () => true),
  killSession: vi.fn(async () => {}),
  listSessions: vi.fn(async () => []),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sendKeys: vi.fn(async () => {}),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

const workspacesFile = () => path.join(mockHome.value, '.purplemux', 'workspaces.json');
const holder: ILeaseHolder = { workspaceId: 'ws-a', tabId: 'tab-1', tabName: null, verified: true, admin: false };

describe('the live-tab snapshot never reads an unreadable workspace list as "no tabs"', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetLeaseGlobals();
    for (const key of ['__purplemuxWorkspaceLock', '__purplemuxWorkspacesContentCache', '__ptLayoutContentCache', '__ptLayoutLock', '__ptTabTokens', '__ptTabTokenLock', '__ptTabTokenRevokeInstalled']) {
      delete (globalThis as Record<string, unknown>)[key];
    }
    mockHome.value = await makeHome();
    await fs.mkdir(path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-a'), { recursive: true });
    await fs.writeFile(path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-a', 'layout.json'), JSON.stringify({
      root: { type: 'pane', id: 'pane-1', activeTabId: 'tab-1', tabs: [{ id: 'tab-1', sessionName: 's1', name: '', order: 0 }] },
      activePaneId: 'pane-1',
      updatedAt: '2026-09-26T00:00:00.000Z',
    }));
  });

  afterEach(async () => {
    await drainLeaseLocks();
    resetLeaseGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('reads the workspaces and their tabs', async () => {
    await fs.writeFile(workspacesFile(), JSON.stringify({ workspaces: [{ id: 'ws-a', name: 'A', directories: [] }] }));
    const { readLiveTabs } = await import('@/lib/tab-lifecycle');
    expect((await readLiveTabs()).tabs.map((t) => t.tabId)).toEqual(['tab-1']);
  });

  it('answers no tabs when there is no workspace list at all', async () => {
    const { readLiveTabs } = await import('@/lib/tab-lifecycle');
    expect(await readLiveTabs()).toEqual({ tabs: [], uncertainWorkspaceIds: new Set() });
  });

  it.each([
    ['unparseable', async () => fs.writeFile(workspacesFile(), '{broken')],
    ['without a workspaces array', async () => fs.writeFile(workspacesFile(), '{}')],
    ['unreadable', async () => fs.mkdir(workspacesFile(), { recursive: true })],
  ])('throws for a workspace list that is %s', async (_label, corrupt) => {
    await corrupt();
    const { readLiveTabs } = await import('@/lib/tab-lifecycle');
    await expect(readLiveTabs()).rejects.toThrow('workspaces.json');
  });

  it('boot survives an unreadable workspace list: the token sweep is skipped, revocation still installed', async () => {
    await fs.writeFile(workspacesFile(), '{broken');
    const { initTabTokens, ensureTabToken, resolveTabToken } = await import('@/lib/tab-token');
    const { emitTabClosed } = await import('@/lib/tab-lifecycle');
    const token = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 's1');

    await expect(initTabTokens()).resolves.toBeUndefined();
    expect(resolveTabToken(token)?.tabId).toBe('tab-1');
    emitTabClosed({ workspaceId: 'ws-a', tabId: 'tab-1', sessionName: 's1', reason: 'layout-removed' });
    expect(resolveTabToken(token)).toBeNull();
    await (globalThis as { __ptTabTokenLock?: Promise<void> }).__ptTabTokenLock;
  });

  it('a runtime sweep over an unreadable workspace list releases nothing', async () => {
    await fs.writeFile(workspacesFile(), JSON.stringify({ workspaces: [{ id: 'ws-a', name: 'A', directories: [] }] }));
    const { acquireLease, listLeases } = await import('@/lib/lease-store');
    const { getLeaseSweeper } = await import('@/lib/lease-sweeper');
    const now = Date.now();
    await acquireLease({ name: 'epic:owned', ttlSeconds: null }, holder, { now: () => now - 1000, isWorkspaceOrchestrator: async () => false });
    await acquireLease({ name: 'merge:x/y' }, holder, { now: () => now - 1000, isWorkspaceOrchestrator: async () => false });

    await fs.writeFile(workspacesFile(), '{broken');
    await expect(getLeaseSweeper().sweep()).rejects.toThrow('workspaces.json');
    expect((await listLeases()).map((l) => l.name)).toEqual(['epic:owned', 'merge:x/y']);
  });
});
