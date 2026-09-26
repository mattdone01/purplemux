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

const resetGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['__ptTabLifecycle', '__ptTabTokens', '__ptTabTokenLock', '__ptTabTokenRevokeInstalled', '__ptLayoutContentCache', '__ptLayoutLock']) {
    delete g[key];
  }
};

const layoutWith = (tabIds: string[]): ILayoutData => ({
  root: {
    type: 'pane',
    id: 'pane-1',
    activeTabId: tabIds[0] ?? null,
    tabs: tabIds.map((id, order) => ({ id, sessionName: `pt-ws-a-pane-1-${id}`, name: '', order })),
  },
  activePaneId: 'pane-1',
  updatedAt: '2026-09-26T00:00:00.000Z',
});

describe('boot cross-check adopts an orphan session under its own tab id', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-orphan-'));
  });

  afterEach(async () => {
    await (globalThis as { __ptTabTokenLock?: Promise<void> }).__ptTabTokenLock;
    resetGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('reuses the id the orphan\'s token was minted for, so PMUX_TAB_ID matches the layout', async () => {
    const { ensureTabToken } = await import('@/lib/tab-token');
    const { crossCheckLayout, collectAllTabs } = await import('@/lib/layout-store');
    await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-orphan' }, 'pt-ws-a-pane-0-tab-orphan');
    const layout = layoutWith(['tab-1']);

    expect(await crossCheckLayout(layout, ['pt-ws-a-pane-1-tab-1', 'pt-ws-a-pane-0-tab-orphan'], 'ws-a')).toBe(true);
    const adopted = collectAllTabs(layout.root).find((t) => t.sessionName === 'pt-ws-a-pane-0-tab-orphan');
    expect(adopted?.id).toBe('tab-orphan');
  });

  it('gives a pre-token orphan a new id', async () => {
    const { crossCheckLayout, collectAllTabs } = await import('@/lib/layout-store');
    const layout = layoutWith(['tab-1']);

    await crossCheckLayout(layout, ['pt-ws-a-pane-1-tab-1', 'pt-ws-a-pane-0-tab-legacy'], 'ws-a');
    const adopted = collectAllTabs(layout.root).find((t) => t.sessionName === 'pt-ws-a-pane-0-tab-legacy');
    expect(adopted?.id).toMatch(/^tab-/);
    expect(adopted?.id).not.toBe('tab-1');
  });

  it('never reuses an id the layout already holds', async () => {
    const { ensureTabToken } = await import('@/lib/tab-token');
    const { crossCheckLayout, collectAllTabs } = await import('@/lib/layout-store');
    await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 'pt-ws-a-pane-0-stale');
    const layout = layoutWith(['tab-1']);

    await crossCheckLayout(layout, ['pt-ws-a-pane-1-tab-1', 'pt-ws-a-pane-0-stale'], 'ws-a');
    const ids = collectAllTabs(layout.root).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
