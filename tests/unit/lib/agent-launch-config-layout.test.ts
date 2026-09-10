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

describe('tab agent launch config persistence', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-agent-launch-config-'));
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('writes explicit pins and preserves them when tabs are reordered', async () => {
    const {
      addTabToPane,
      readLayoutFile,
      reorderTabsInPane,
      resolveLayoutFile,
      writeLayoutFile,
    } = await import('@/lib/layout-store');
    const workspaceId = 'ws-pins';
    const filePath = resolveLayoutFile(workspaceId);
    const initial: ILayoutData = {
      root: {
        type: 'pane',
        id: 'pane-one',
        activeTabId: 'tab-existing',
        tabs: [{ id: 'tab-existing', sessionName: 'existing', name: 'existing', order: 0 }],
      },
      activePaneId: 'pane-one',
      updatedAt: '2026-09-10T00:00:00.000Z',
    };
    await writeLayoutFile(initial, filePath);

    const created = await addTabToPane(
      workspaceId,
      'pane-one',
      'worker',
      undefined,
      'codex-cli',
      undefined,
      { agentLaunchConfig: { model: 'gpt-5.6-sol', effort: 'high' } },
    );

    expect(created?.agentLaunchConfig).toEqual({ model: 'gpt-5.6-sol', effort: 'high' });
    await reorderTabsInPane(workspaceId, 'pane-one', [created!.id, 'tab-existing']);
    const persisted = await readLayoutFile(filePath);
    expect(persisted?.root.type).toBe('pane');
    if (persisted?.root.type !== 'pane') throw new Error('Expected pane layout');
    expect(persisted.root.tabs[0].agentLaunchConfig).toEqual({ model: 'gpt-5.6-sol', effort: 'high' });
    expect(persisted.root.tabs[1].agentLaunchConfig).toBeUndefined();
  });
});
