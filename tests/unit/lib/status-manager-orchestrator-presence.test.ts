import fs from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITabStatusEntry } from '@/types/status';
import type { IWorkspace } from '@/types/terminal';

const mocks = vi.hoisted(() => ({
  getWorkspacesCached: vi.fn(),
  listLeases: vi.fn(),
  readLayoutFile: vi.fn(),
  collectAllTabs: vi.fn(),
  readLatestStandupEvidence: vi.fn(),
  readLivenessEvidence: vi.fn(),
  statusForTab: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: mocks.getWorkspacesCached,
  getWorkspaceByIdCached: vi.fn(),
}));

vi.mock('@/lib/lease-store', () => ({ listLeases: mocks.listLeases }));
vi.mock('@/lib/standup-store', () => ({
  addStandup: vi.fn(),
  readAllLatestStandups: vi.fn(async () => ({})),
  readLatestStandupEvidence: mocks.readLatestStandupEvidence,
}));
vi.mock('@/lib/liveness-store', () => ({ readLivenessEvidence: mocks.readLivenessEvidence }));
vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => ({ statusForTab: mocks.statusForTab }),
}));
vi.mock('@/lib/layout-store', () => ({
  resolveLayoutFile: (workspaceId: string) => `/tmp/${workspaceId}/layout.json`,
  readLayoutFile: mocks.readLayoutFile,
  collectAllTabs: mocks.collectAllTabs,
  updateTabCliStatus: vi.fn(async () => {}),
  updateTabAgentSummary: vi.fn(async () => {}),
  updateTabAgentState: vi.fn(async () => {}),
  parseSessionName: vi.fn(),
  clearReportsTo: vi.fn(async () => {}),
  updateTabWatchdogTurnEnd: vi.fn(async () => {}),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({ name: 'status-socket', deliver: vi.fn() })),
  createWebPushChannel: vi.fn(() => ({ name: 'web-push', deliver: vi.fn() })),
  getNotificationDispatcher: () => ({ dispatch: mocks.dispatch, register: vi.fn(), has: vi.fn(() => false) }),
}));

import { orchestratorPresenceStateFile } from '@/lib/orchestrator-presence-store';
import { getOrchestratorPresenceMonitor } from '@/lib/orchestrator-presence';
import { StatusManager } from '@/lib/status-manager';

const workspace = (orchestratorTabId: string | null): IWorkspace => ({
  id: 'ws-1',
  name: 'Payments',
  directories: ['/tmp'],
  orchestration: { enabled: true, orchestratorTabId },
});

const entry = (): ITabStatusEntry => ({
  cliState: 'busy',
  workspaceId: 'ws-1',
  tabName: 'orchestrator',
  tmuxSession: 'tmux-orch',
  panelType: 'codex-cli',
  agentProviderId: 'codex',
});

const runPresence = (manager: StatusManager): Promise<void> =>
  (manager as unknown as { runOrchestratorPresence: () => Promise<void> }).runOrchestratorPresence();

const resetMonitor = (): void => {
  delete (globalThis as unknown as { __ptOrchestratorPresenceMonitor?: unknown }).__ptOrchestratorPresenceMonitor;
};

beforeEach(async () => {
  vi.clearAllMocks();
  resetMonitor();
  await fs.rm(orchestratorPresenceStateFile(), { force: true });
  mocks.getWorkspacesCached.mockResolvedValue({ workspaces: [workspace('orch')] });
  mocks.listLeases.mockResolvedValue([{ name: 'epic:payments', holder: { workspaceId: 'ws-1' } }]);
  mocks.readLayoutFile.mockResolvedValue({ root: {} });
  mocks.collectAllTabs.mockReturnValue([{ id: 'orch', name: 'orchestrator', panelType: 'codex-cli' }]);
  mocks.readLatestStandupEvidence.mockResolvedValue({ known: true, standup: null });
  mocks.readLivenessEvidence.mockResolvedValue({ known: true, data: { probes: [], jobs: [] } });
  mocks.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  mocks.dispatch.mockResolvedValue({});
});

describe('status manager orchestrator presence collector', () => {
  it('surfaces an unreadable workspace registry instead of retaining a green snapshot', async () => {
    mocks.getWorkspacesCached.mockResolvedValue(null);
    const manager = new StatusManager();

    await expect(runPresence(manager)).rejects.toThrow('workspace registry unreadable');

    expect(getOrchestratorPresenceMonitor().snapshot()).toMatchObject({
      state: 'error',
      error: 'workspace registry unreadable',
    });
  });

  it('keeps mixed unreadable collector evidence visible with a live coordinator', async () => {
    mocks.readLatestStandupEvidence.mockResolvedValue({ known: false });
    mocks.readLivenessEvidence.mockResolvedValue({ known: false });
    const manager = new StatusManager();
    manager.registerTab('orch', entry());

    await runPresence(manager);

    expect(getOrchestratorPresenceMonitor().snapshot()).toMatchObject({
      state: 'ready',
      issues: [{
        state: 'uncertain',
        workState: 'remaining',
        orchestratorState: 'usable',
        evidence: expect.arrayContaining(['latest standup unreadable', 'registered background work unreadable']),
      }],
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('persists dedup across monitor reconstruction and rearms after confirmed recovery', async () => {
    mocks.getWorkspacesCached.mockResolvedValue({ workspaces: [workspace(null)] });
    mocks.collectAllTabs.mockReturnValue([{ id: 'worker', name: 'worker', panelType: 'codex-cli' }]);
    const first = new StatusManager();
    await runPresence(first);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);

    resetMonitor();
    const restarted = new StatusManager();
    await runPresence(restarted);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);

    mocks.getWorkspacesCached.mockResolvedValue({ workspaces: [workspace('orch')] });
    mocks.collectAllTabs.mockReturnValue([{ id: 'orch', name: 'orchestrator', panelType: 'codex-cli' }]);
    restarted.registerTab('orch', entry());
    await runPresence(restarted);

    mocks.getWorkspacesCached.mockResolvedValue({ workspaces: [workspace(null)] });
    mocks.collectAllTabs.mockReturnValue([{ id: 'worker', name: 'worker', panelType: 'codex-cli' }]);
    await runPresence(restarted);
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  });

  it('coalesces overlapping collector scans before a second evidence read starts', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    mocks.readLayoutFile.mockImplementationOnce(async () => {
      await blocked;
      return { root: {} };
    });
    const manager = new StatusManager();
    manager.registerTab('orch', entry());

    const first = runPresence(manager);
    await vi.waitFor(() => expect(mocks.readLayoutFile).toHaveBeenCalledTimes(1));
    const second = runPresence(manager);
    await Promise.resolve();
    expect(mocks.getWorkspacesCached).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);
    expect(mocks.readLayoutFile).toHaveBeenCalledTimes(1);
  });
});
