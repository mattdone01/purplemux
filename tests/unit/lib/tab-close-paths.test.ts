import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILayoutData } from '@/types/terminal';

// ADR-0016 / story 16 review r1 finding 2: every close path hands the tab id
// to killSession, so the tab's processes are reaped whichever way it closes.

const mockHome = vi.hoisted(() => ({ value: '' }));
const REAP = { reaper: 'linux', envMarker: 'present', killed: [{ pid: 4242, comm: 'sleep', args: 'sleep 600' }], survivors: [] };
const tmux = vi.hoisted(() => ({ killSession: vi.fn() }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/tmux', () => ({
  createSession: vi.fn(async () => {}),
  hasSession: vi.fn(async () => true),
  killSession: tmux.killSession,
  listSessions: vi.fn(async () => []),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sendKeys: vi.fn(async () => {}),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/providers/claude', () => ({ claudeProvider: {} }));

const WS = 'ws-close';

const layout = (): ILayoutData => ({
  root: {
    type: 'split',
    orientation: 'horizontal',
    ratio: 50,
    children: [
      {
        type: 'pane',
        id: 'pane-a',
        activeTabId: 'tab-a1',
        tabs: [
          { id: 'tab-a1', sessionName: 's-a1', name: 'a1', order: 0 },
          { id: 'tab-a2', sessionName: 's-a2', name: 'a2', order: 1, panelType: 'claude-code' },
          { id: 'tab-web', sessionName: 's-web', name: 'web', order: 2, panelType: 'web-browser' },
        ],
      },
      { type: 'pane', id: 'pane-b', activeTabId: 'tab-b1', tabs: [{ id: 'tab-b1', sessionName: 's-b1', name: 'b1', order: 0 }] },
    ],
  },
  activePaneId: 'pane-a',
  updatedAt: '2026-09-26T00:00:00.000Z',
});

describe('every close path reaps by tab id (ADR-0016)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tmux.killSession.mockResolvedValue(REAP);
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-close-paths-'));
    const store = await import('@/lib/layout-store');
    await store.writeLayoutFile(layout(), store.resolveLayoutFile(WS));
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('closeTab (CLI `tab close`) passes the tab id and returns the reap', async () => {
    const store = await import('@/lib/layout-store');
    expect(await store.closeTab(WS, 'pane-a', 'tab-a2')).toEqual({ ok: true, reap: REAP });
    expect(tmux.killSession).toHaveBeenCalledWith('s-a2', { tabId: 'tab-a2', keepProcesses: undefined });
  });

  it('closeTab --keep-processes passes keepProcesses', async () => {
    const store = await import('@/lib/layout-store');
    await store.closeTab(WS, 'pane-a', 'tab-a2', { keepProcesses: true });
    expect(tmux.killSession).toHaveBeenCalledWith('s-a2', { tabId: 'tab-a2', keepProcesses: true });
  });

  it('removeTabFromPane (the UI close, including the auto-close after the shell exits) passes the tab id', async () => {
    const store = await import('@/lib/layout-store');
    expect(await store.removeTabFromPane(WS, 'pane-a', 'tab-a1')).toBe(true);
    expect(tmux.killSession).toHaveBeenCalledWith('s-a1', { tabId: 'tab-a1', keepProcesses: undefined });
  });

  it('a browser tab has no session and no processes to reap', async () => {
    const store = await import('@/lib/layout-store');
    expect(await store.closeTab(WS, 'pane-a', 'tab-web')).toEqual({ ok: true, reap: null });
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it('closePaneInLayout passes each non-browser tab its own id', async () => {
    const store = await import('@/lib/layout-store');
    await store.closePaneInLayout(WS, 'pane-a');
    expect(tmux.killSession.mock.calls).toEqual(expect.arrayContaining([
      ['s-a1', { tabId: 'tab-a1' }],
      ['s-a2', { tabId: 'tab-a2' }],
    ]));
    expect(tmux.killSession).toHaveBeenCalledTimes(2);
  });

  it('deleteWorkspace passes every tab its own id', async () => {
    const workspaces = await import('@/lib/workspace-store');
    const dir = path.join(mockHome.value, 'proj');
    await fs.mkdir(dir);
    const ws = await workspaces.createWorkspace(dir);
    const store = await import('@/lib/layout-store');
    await store.writeLayoutFile(layout(), store.resolveLayoutFile(ws.id));
    tmux.killSession.mockClear();
    expect(await workspaces.deleteWorkspace(ws.id)).toBe(true);
    expect(tmux.killSession.mock.calls).toEqual(expect.arrayContaining([
      ['s-a1', { tabId: 'tab-a1' }],
      ['s-a2', { tabId: 'tab-a2' }],
      ['s-b1', { tabId: 'tab-b1' }],
    ]));
  });
});
