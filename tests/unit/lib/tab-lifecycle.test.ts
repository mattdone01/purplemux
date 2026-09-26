import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITabClosedEvent } from '@/lib/tab-lifecycle';

const mockHome = vi.hoisted(() => ({ value: '' }));
const workspaces = vi.hoisted(() => ({ list: [] as { id: string }[] }));

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
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sendKeys: vi.fn(async () => {}),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/providers/claude', () => ({ claudeProvider: {} }));
vi.mock('@/lib/workspace-store', () => ({
  readWorkspaceIdsStrict: async () => workspaces.list.map((w) => w.id),
}));

const resetGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  delete g.__ptTabLifecycle;
  delete g.__ptTabTokens;
  delete g.__ptTabTokenLock;
  delete g.__ptTabTokenRevokeInstalled;
  delete g.__ptLayoutContentCache;
  delete g.__ptLayoutLock;
};

const tab = (id: string) => ({ id, sessionName: `s-${id}` });

describe('tab lifecycle', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-tab-lifecycle-'));
    workspaces.list = [];
  });

  afterEach(async () => {
    await (globalThis as { __ptTabTokenLock?: Promise<void> }).__ptTabTokenLock;
    resetGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('emits one tab-closed per tab that leaves a layout, and nothing for additions', async () => {
    const { observeLayoutTabs, onTabClosed } = await import('@/lib/tab-lifecycle');
    const events: ITabClosedEvent[] = [];
    onTabClosed((e) => events.push(e));

    observeLayoutTabs('ws-a', [tab('t1'), tab('t2')]);
    observeLayoutTabs('ws-a', [tab('t1'), tab('t2'), tab('t3')]);
    observeLayoutTabs('ws-a', [tab('t3')]);
    observeLayoutTabs('ws-a', [tab('t3')]);

    expect(events).toEqual([
      { workspaceId: 'ws-a', tabId: 't1', sessionName: 's-t1', reason: 'layout-removed' },
      { workspaceId: 'ws-a', tabId: 't2', sessionName: 's-t2', reason: 'layout-removed' },
    ]);
  });

  it('seeds a workspace it has not seen written from the previous layout', async () => {
    const { observeLayoutTabs, onTabClosed, hasKnownTabs } = await import('@/lib/tab-lifecycle');
    const events: ITabClosedEvent[] = [];
    onTabClosed((e) => events.push(e));

    expect(hasKnownTabs('ws-a')).toBe(false);
    observeLayoutTabs('ws-a', [tab('t2')], [tab('t1'), tab('t2')]);
    expect(hasKnownTabs('ws-a')).toBe(true);
    expect(events.map((e) => e.tabId)).toEqual(['t1']);
  });

  it('prefers what it saw written over a stale previous', async () => {
    const { observeLayoutTabs, onTabClosed } = await import('@/lib/tab-lifecycle');
    const events: ITabClosedEvent[] = [];
    onTabClosed((e) => events.push(e));

    observeLayoutTabs('ws-a', [tab('t1')]);
    observeLayoutTabs('ws-a', [], [tab('t1'), tab('t-stale')]);
    expect(events.map((e) => e.tabId)).toEqual(['t1']);
  });

  it('keeps workspaces separate', async () => {
    const { observeLayoutTabs, onTabClosed } = await import('@/lib/tab-lifecycle');
    const events: ITabClosedEvent[] = [];
    onTabClosed((e) => events.push(e));

    observeLayoutTabs('ws-a', [tab('t1')]);
    observeLayoutTabs('ws-b', [tab('t2')]);
    observeLayoutTabs('ws-b', []);
    expect(events).toEqual([{ workspaceId: 'ws-b', tabId: 't2', sessionName: 's-t2', reason: 'layout-removed' }]);
  });

  it('emits workspace-deleted for every tab of a removed workspace, once', async () => {
    const { observeLayoutTabs, observeWorkspaceRemoved, onTabClosed, hasKnownTabs } = await import('@/lib/tab-lifecycle');
    const events: ITabClosedEvent[] = [];
    onTabClosed((e) => events.push(e));

    observeLayoutTabs('ws-a', [tab('t1'), tab('t2')]);
    observeWorkspaceRemoved('ws-a');
    observeWorkspaceRemoved('ws-a');

    expect(events.map((e) => [e.tabId, e.reason])).toEqual([['t1', 'workspace-deleted'], ['t2', 'workspace-deleted']]);
    expect(hasKnownTabs('ws-a')).toBe(false);
  });

  it('uses the previous layout for a removed workspace it never saw written', async () => {
    const { observeWorkspaceRemoved, onTabClosed } = await import('@/lib/tab-lifecycle');
    const events: ITabClosedEvent[] = [];
    onTabClosed((e) => events.push(e));

    observeWorkspaceRemoved('ws-a', [tab('t9')]);
    expect(events.map((e) => e.tabId)).toEqual(['t9']);
  });

  it('isolates a failing listener and supports unsubscribe', async () => {
    const { emitTabClosed, onTabClosed } = await import('@/lib/tab-lifecycle');
    const seen: string[] = [];
    onTabClosed(() => { throw new Error('boom'); });
    const off = onTabClosed((e) => seen.push(`a:${e.tabId}`));
    onTabClosed((e) => seen.push(`b:${e.tabId}`));

    emitTabClosed({ workspaceId: 'ws-a', tabId: 't1', sessionName: 's', reason: 'layout-removed' });
    off();
    emitTabClosed({ workspaceId: 'ws-a', tabId: 't2', sessionName: 's', reason: 'layout-removed' });

    expect(seen).toEqual(['a:t1', 'b:t1', 'b:t2']);
  });

  it('shares one listener set across module instances (custom server and Next API graphs)', async () => {
    const first = await import('@/lib/tab-lifecycle');
    const seen: string[] = [];
    first.onTabClosed((e) => seen.push(e.tabId));

    vi.resetModules();
    const second = await import('@/lib/tab-lifecycle');
    second.emitTabClosed({ workspaceId: 'ws-a', tabId: 't1', sessionName: 's', reason: 'layout-removed' });
    expect(seen).toEqual(['t1']);
  });

  it('lists the live tabs of every workspace layout on disk', async () => {
    const { writeLayoutFile, resolveLayoutFile } = await import('@/lib/layout-store');
    const { readLiveTabs, listLiveTabIds } = await import('@/lib/tab-lifecycle');
    workspaces.list = [{ id: 'ws-a' }, { id: 'ws-b' }, { id: 'ws-empty' }];
    await writeLayoutFile({
      root: { type: 'pane', id: 'pane-1', activeTabId: 'tab-1', tabs: [
        { id: 'tab-1', sessionName: 'pt-ws-a-pane-1-tab-1', name: '', order: 0 },
        { id: 'tab-2', sessionName: 'pt-ws-a-pane-1-tab-2', name: '', order: 1 },
      ] },
      activePaneId: 'pane-1',
      updatedAt: '2026-09-26T00:00:00.000Z',
    }, resolveLayoutFile('ws-a'));
    await writeLayoutFile({
      root: { type: 'pane', id: 'pane-9', activeTabId: 'tab-9', tabs: [
        { id: 'tab-9', sessionName: 'pt-ws-b-pane-9-tab-9', name: '', order: 0 },
      ] },
      activePaneId: 'pane-9',
      updatedAt: '2026-09-26T00:00:00.000Z',
    }, resolveLayoutFile('ws-b'));

    expect((await readLiveTabs()).tabs).toEqual([
      { workspaceId: 'ws-a', tabId: 'tab-1', sessionName: 'pt-ws-a-pane-1-tab-1' },
      { workspaceId: 'ws-a', tabId: 'tab-2', sessionName: 'pt-ws-a-pane-1-tab-2' },
      { workspaceId: 'ws-b', tabId: 'tab-9', sessionName: 'pt-ws-b-pane-9-tab-9' },
    ]);
    expect(await listLiveTabIds()).toEqual(new Set(['tab-1', 'tab-2', 'tab-9']));
  });

  it('reports a workspace whose layout is unreadable or unparseable as uncertain, and a missing layout as empty', async () => {
    const { writeLayoutFile, resolveLayoutFile } = await import('@/lib/layout-store');
    const { readLiveTabs } = await import('@/lib/tab-lifecycle');
    workspaces.list = [{ id: 'ws-ok' }, { id: 'ws-corrupt' }, { id: 'ws-dir' }, { id: 'ws-missing' }];
    await writeLayoutFile({
      root: { type: 'pane', id: 'pane-1', activeTabId: 'tab-1', tabs: [{ id: 'tab-1', sessionName: 's1', name: '', order: 0 }] },
      activePaneId: 'pane-1',
      updatedAt: '2026-09-26T00:00:00.000Z',
    }, resolveLayoutFile('ws-ok'));
    await fs.mkdir(path.dirname(resolveLayoutFile('ws-corrupt')), { recursive: true });
    await fs.writeFile(resolveLayoutFile('ws-corrupt'), '{not json');
    await fs.mkdir(resolveLayoutFile('ws-dir'), { recursive: true });

    const snapshot = await readLiveTabs();
    expect(snapshot.tabs.map((t) => t.tabId)).toEqual(['tab-1']);
    expect([...snapshot.uncertainWorkspaceIds].sort()).toEqual(['ws-corrupt', 'ws-dir']);
  });
});
