import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITabClosedEvent } from '@/lib/tab-lifecycle';
import type { ILayoutData } from '@/types/terminal';

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
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ removeTab: vi.fn() }) }));
vi.mock('@/lib/grok-home', () => ({ removeWorkspaceGrokHome: vi.fn(async () => {}) }));
vi.mock('@/lib/workspace-home', () => ({ removeWorkspaceClaudeHome: vi.fn(async () => {}) }));

const resetGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  for (const key of [
    '__ptTabLifecycle', '__ptTabTokens', '__ptTabTokenLock', '__ptTabTokenRevokeInstalled',
    '__ptLayoutContentCache', '__ptLayoutLock', '__ptWorkspaceTokens', '__ptCliToken',
    '__purplemuxWorkspaceLock', '__purplemuxWorkspacesContentCache',
  ]) delete g[key];
};

const WS = 'ws-a';
const session = (paneId: string, tabId: string) => `pt-${WS}-${paneId}-${tabId}`;

const layout: ILayoutData = {
  root: {
    type: 'split',
    orientation: 'horizontal',
    ratio: 50,
    children: [
      { type: 'pane', id: 'pane-1', activeTabId: 'tab-1', tabs: [
        { id: 'tab-1', sessionName: session('pane-1', 'tab-1'), name: 'one', order: 0 },
        { id: 'tab-2', sessionName: session('pane-1', 'tab-2'), name: 'two', order: 1 },
      ] },
      { type: 'pane', id: 'pane-2', activeTabId: 'tab-3', tabs: [
        { id: 'tab-3', sessionName: session('pane-2', 'tab-3'), name: 'three', order: 0 },
      ] },
    ],
  },
  activePaneId: 'pane-1',
  updatedAt: '2026-09-26T00:00:00.000Z',
};

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    end() { return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const request = (init: Partial<NextApiRequest>): NextApiRequest =>
  ({ headers: {}, query: {}, body: undefined, ...init }) as NextApiRequest;

let tokens: Record<string, string>;
let events: ITabClosedEvent[];

const eventsFor = (tabId: string) => events.filter((e) => e.tabId === tabId);

describe('one tab-closed event per close path, and the tab token dies with it', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-tab-closed-'));
    const base = path.join(mockHome.value, '.purplemux');
    await fs.mkdir(path.join(base, 'workspaces', WS), { recursive: true });
    await fs.writeFile(path.join(base, 'workspaces.json'), JSON.stringify({
      workspaces: [{ id: WS, name: 'A', directories: [mockHome.value] }],
      groups: [],
      sidebarCollapsed: false,
      sidebarWidth: 240,
      updatedAt: '2026-09-26T00:00:00.000Z',
    }));
    // Written directly, as a previous server process left it: nothing in this
    // process has observed the layout yet.
    await fs.writeFile(path.join(base, 'workspaces', WS, 'layout.json'), JSON.stringify(layout));

    const { ensureTabToken, installTabTokenRevocation } = await import('@/lib/tab-token');
    const { onTabClosed } = await import('@/lib/tab-lifecycle');
    tokens = {};
    for (const [paneId, tabId] of [['pane-1', 'tab-1'], ['pane-1', 'tab-2'], ['pane-2', 'tab-3']]) {
      tokens[tabId] = await ensureTabToken({ workspaceId: WS, tabId }, session(paneId, tabId));
    }
    installTabTokenRevocation();
    events = [];
    onTabClosed((e) => events.push(e));
  });

  afterEach(async () => {
    await (globalThis as { __ptTabTokenLock?: Promise<void> }).__ptTabTokenLock;
    resetGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('CLI: DELETE /api/cli/tabs/<id>, authorised by a sibling tab token', async () => {
    const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/index');
    const { resolveTabToken } = await import('@/lib/tab-token');
    const { state, res } = fakeResponse();

    await handler(request({
      method: 'DELETE',
      headers: { 'x-pmux-token': tokens['tab-2'] },
      query: { tabId: 'tab-1', workspaceId: WS },
    }), res);

    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({ ok: true });
    expect(events).toEqual([{ workspaceId: WS, tabId: 'tab-1', sessionName: session('pane-1', 'tab-1'), reason: 'layout-removed' }]);
    expect(resolveTabToken(tokens['tab-1'])).toBeNull();
    expect(resolveTabToken(tokens['tab-2'])?.tabId).toBe('tab-2');
  });

  it('web UI: DELETE /api/layout/pane/<pane>/tabs/<id>', async () => {
    const { default: handler } = await import('@/pages/api/layout/pane/[paneId]/tabs/[tabId]/index');
    const { resolveTabToken } = await import('@/lib/tab-token');
    const { state, res } = fakeResponse();

    await handler(request({ method: 'DELETE', query: { workspace: WS, paneId: 'pane-1', tabId: 'tab-2' } }), res);

    expect(state.statusCode).toBe(204);
    expect(eventsFor('tab-2')).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(resolveTabToken(tokens['tab-2'])).toBeNull();
  });

  it('web UI: closing a pane closes each of its tabs once', async () => {
    const { default: handler } = await import('@/pages/api/layout/pane/[paneId]/index');
    const { resolveTabToken } = await import('@/lib/tab-token');
    const { state, res } = fakeResponse();

    await handler(request({ method: 'DELETE', query: { workspace: WS, paneId: 'pane-2' } }), res);

    expect(state.statusCode).toBe(200);
    expect(events.map((e) => e.tabId)).toEqual(['tab-3']);
    expect(resolveTabToken(tokens['tab-3'])).toBeNull();
    expect(resolveTabToken(tokens['tab-1'])?.tabId).toBe('tab-1');
  });

  it('workspace delete: every tab closes exactly once and no token of the workspace resolves', async () => {
    const { deleteWorkspace } = await import('@/lib/workspace-store');
    const { resolveTabToken } = await import('@/lib/tab-token');

    expect(await deleteWorkspace(WS)).toBe(true);

    expect(events.map((e) => [e.tabId, e.reason]).sort()).toEqual([
      ['tab-1', 'workspace-deleted'],
      ['tab-2', 'workspace-deleted'],
      ['tab-3', 'workspace-deleted'],
    ]);
    for (const token of Object.values(tokens)) expect(resolveTabToken(token)).toBeNull();
  });

  it('a close followed by an unrelated write emits nothing more', async () => {
    const { removeTabFromPane, renameTabInPane } = await import('@/lib/layout-store');

    expect(await removeTabFromPane(WS, 'pane-1', 'tab-1')).toBe(true);
    await renameTabInPane(WS, 'pane-1', 'tab-2', 'renamed');
    expect(await removeTabFromPane(WS, 'pane-1', 'tab-1')).toBe(false);

    expect(events.map((e) => e.tabId)).toEqual(['tab-1']);
  });
});
