import fs from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITabStatusEntry } from '@/types/status';
import type { IWorkspace } from '@/types/terminal';

const mocks = vi.hoisted(() => ({
  getWorkspacesCached: vi.fn(),
  readLeaseEvidence: vi.fn(),
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

vi.mock('@/lib/lease-store', () => ({ readLeaseEvidence: mocks.readLeaseEvidence }));
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
  mocks.readLeaseEvidence.mockResolvedValue({
    known: true,
    leases: [{ name: 'epic:payments', holder: { workspaceId: 'ws-1' } }],
  });
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

  it('keeps malformed lease evidence uncertain instead of treating it as no active epic', async () => {
    mocks.readLeaseEvidence.mockResolvedValue({ known: false });
    mocks.readLatestStandupEvidence.mockResolvedValue({ known: true, standup: {
      workspaceId: 'ws-1', at: 1, state: 'done', headline: 'Done', items: [], blockers: [], needsHuman: false, next: [],
    } });
    const manager = new StatusManager();
    manager.registerTab('orch', entry());

    await runPresence(manager);

    expect(getOrchestratorPresenceMonitor().snapshot()).toMatchObject({
      state: 'ready',
      issues: [{ state: 'uncertain', evidence: expect.arrayContaining(['epic leases unreadable']) }],
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('checks registered job owners absent from the layout through liveness PID assessment', async () => {
    mocks.getWorkspacesCached.mockResolvedValue({ workspaces: [workspace(null)] });
    mocks.readLeaseEvidence.mockResolvedValue({ known: true, leases: [] });
    mocks.readLatestStandupEvidence.mockResolvedValue({ known: true, standup: {
      workspaceId: 'ws-1', at: 1, state: 'done', headline: 'Done', items: [], blockers: [], needsHuman: false, next: [],
    } });
    mocks.collectAllTabs.mockReturnValue([]);
    mocks.readLivenessEvidence.mockResolvedValue({
      known: true,
      data: { probes: [], jobs: [{ workspaceId: 'ws-1', tabId: 'closed-worker', pid: 4242, registeredAt: 1 }] },
    });
    mocks.statusForTab.mockResolvedValue({
      probes: [],
      backgroundJobs: [{ pid: 4242, alive: true, registeredAt: 1, ageS: 10 }],
    });
    const manager = new StatusManager();

    await runPresence(manager);

    expect(mocks.statusForTab).toHaveBeenCalledWith('closed-worker');
    expect(getOrchestratorPresenceMonitor().snapshot()).toMatchObject({
      state: 'ready',
      issues: [{ state: 'missing', evidence: ['live registered background work: closed-worker'] }],
    });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps registered job evidence unknown when PID assessment cannot account for it', async () => {
    mocks.getWorkspacesCached.mockResolvedValue({ workspaces: [workspace(null)] });
    mocks.readLeaseEvidence.mockResolvedValue({ known: true, leases: [] });
    mocks.collectAllTabs.mockReturnValue([]);
    mocks.readLivenessEvidence.mockResolvedValue({
      known: true,
      data: { probes: [], jobs: [{ workspaceId: 'ws-1', tabId: 'closed-worker', pid: 4242, registeredAt: 1 }] },
    });
    mocks.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
    const manager = new StatusManager();

    await runPresence(manager);

    expect(getOrchestratorPresenceMonitor().snapshot()).toMatchObject({
      state: 'ready',
      issues: [{ state: 'uncertain', evidence: expect.arrayContaining(['registered background work unreadable']) }],
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('retains confirmed live work beside rejected and missing-PID liveness evidence', async () => {
    mocks.getWorkspacesCached.mockResolvedValue({ workspaces: [workspace(null)] });
    mocks.readLeaseEvidence.mockResolvedValue({ known: true, leases: [] });
    mocks.readLatestStandupEvidence.mockResolvedValue({ known: true, standup: {
      workspaceId: 'ws-1', at: 1, state: 'done', headline: 'Done', items: [], blockers: [], needsHuman: false, next: [],
    } });
    mocks.collectAllTabs.mockReturnValue([]);
    mocks.readLivenessEvidence.mockResolvedValue({
      known: true,
      data: {
        probes: [],
        jobs: [
          { workspaceId: 'ws-1', tabId: 'live-worker', pid: 1001, registeredAt: 1 },
          { workspaceId: 'ws-1', tabId: 'rejected-worker', pid: 1002, registeredAt: 1 },
          { workspaceId: 'ws-1', tabId: 'missing-pid-worker', pid: 1003, registeredAt: 1 },
        ],
      },
    });
    mocks.statusForTab.mockImplementation(async (tabId: string) => {
      if (tabId === 'rejected-worker') throw new Error('liveness unavailable');
      return {
        probes: [],
        backgroundJobs: tabId === 'live-worker'
          ? [{ pid: 1001, alive: true, registeredAt: 1, ageS: 10 }]
          : [],
      };
    });
    const manager = new StatusManager();

    await runPresence(manager);

    expect(getOrchestratorPresenceMonitor().snapshot()).toMatchObject({
      state: 'ready',
      issues: [{
        state: 'missing',
        workState: 'remaining',
        evidence: expect.arrayContaining([
          'live registered background work: live-worker',
          'registered background work unreadable',
        ]),
      }],
    });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
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
