import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sendKeys: vi.fn(async () => {}),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/providers/claude', () => ({ claudeProvider: {} }));

describe('reportsTo in the layout (ADR-0018)', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-reports-to-'));
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const seed = async () => {
    const store = await import('@/lib/layout-store');
    const workspaceId = 'ws-rt';
    const filePath = store.resolveLayoutFile(workspaceId);
    const initial: ILayoutData = {
      root: {
        type: 'pane',
        id: 'pane-one',
        activeTabId: 'tab-o2',
        tabs: [
          { id: 'tab-o2', sessionName: 'o2', name: 'o2', order: 0 },
          { id: 'tab-w1', sessionName: 'w1', name: 'w1', order: 1, reportsTo: 'tab-o2' },
          { id: 'tab-w2', sessionName: 'w2', name: 'w2', order: 2, reportsTo: 'tab-o3' },
        ],
      },
      activePaneId: 'pane-one',
      updatedAt: '2026-09-26T00:00:00.000Z',
    };
    await store.writeLayoutFile(initial, filePath);
    const tabs = async () => {
      const layout = await store.readLayoutFile(filePath);
      if (layout?.root.type !== 'pane') throw new Error('Expected pane layout');
      return Object.fromEntries(layout.root.tabs.map((t) => [t.id, t.reportsTo]));
    };
    return { store, workspaceId, tabs };
  };

  it('persists reportsTo given at tab creation', async () => {
    const { store, workspaceId, tabs } = await seed();
    const created = await store.addTabToPane(workspaceId, 'pane-one', 'w3', undefined, 'terminal', undefined, { reportsTo: 'tab-o2' });
    expect((await tabs())[created!.id]).toBe('tab-o2');
  });

  it('sets and clears one tab and reports a missing tab', async () => {
    const { store, workspaceId, tabs } = await seed();
    expect(await store.setTabReportsTo(workspaceId, 'tab-w2', 'tab-o2')).toBe(true);
    expect((await tabs())['tab-w2']).toBe('tab-o2');
    expect(await store.setTabReportsTo(workspaceId, 'tab-w2', null)).toBe(true);
    expect((await tabs())['tab-w2']).toBeUndefined();
    expect(await store.setTabReportsTo(workspaceId, 'tab-gone', 'tab-o2')).toBe(false);
  });

  it('clears every reportsTo that names a closed tab, and only those', async () => {
    const { store, workspaceId, tabs } = await seed();
    expect(await store.clearReportsTo(workspaceId, 'tab-o2')).toEqual(['tab-w1']);
    expect(await tabs()).toEqual({ 'tab-o2': undefined, 'tab-w1': undefined, 'tab-w2': 'tab-o3' });
    expect(await store.clearReportsTo(workspaceId, 'tab-o2')).toEqual([]);
  });
});
