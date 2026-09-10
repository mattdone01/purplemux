import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import { KICKOFF_FALLBACK_DELAY_MS, ORCH_IDLE_HEARTBEAT_MS } from '@/lib/orchestration';
import type { TLivenessEvent } from '@/types/liveness';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

const workspaceStore = vi.hoisted(() => ({
  getWorkspaceByIdCached: vi.fn(),
  getWorkspacesCached: vi.fn(),
}));

const liveness = vi.hoisted(() => ({
  statusForTab: vi.fn(),
}));

vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: workspaceStore.getWorkspaceByIdCached,
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: workspaceStore.getWorkspacesCached,
}));

vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => liveness,
}));

const policyLock = (
  checkPolicy: (...args: unknown[]) => Promise<{ ok: boolean; error?: string }>,
): IAutomatedPromptDispatcherDeps['withPolicyLock'] =>
  async (workspaceId, target, deliver) => deliver((options) => checkPolicy(workspaceId, target, options));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const tab = (id: string): ITab => ({
  id,
  name: id,
  order: 0,
  sessionName: `tmux-${id}`,
  panelType: 'codex-cli',
  agentLaunchConfig: { model: 'gpt-6-astra', effort: 'medium' },
});

const entry = (id: string): ITabStatusEntry => ({
  cliState: 'idle',
  workspaceId: 'ws-1',
  tabName: id,
  tmuxSession: `tmux-${id}`,
  panelType: 'codex-cli',
  agentProviderId: 'codex',
});

const completed = (pid: number): TLivenessEvent => ({
  kind: 'bg-completed',
  job: {
    workspaceId: 'ws-1',
    tabId: 'worker',
    pid,
    label: `job-${pid}`,
    registeredAt: 0,
  },
  exitCode: 0,
  stderrTail: null,
});

describe('status manager automated prompt call paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceStore.getWorkspaceByIdCached.mockResolvedValue({
      id: 'ws-1',
      name: 'workspace',
      directories: ['/tmp'],
      orchestration: { enabled: true, orchestratorTabId: 'root' },
    });
    workspaceStore.getWorkspacesCached.mockResolvedValue({
      workspaces: [{
        id: 'ws-1',
        name: 'workspace',
        directories: ['/tmp'],
        orchestration: { enabled: true, orchestratorTabId: 'root' },
      }],
    });
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps Codex session metadata unchanged until a verified launch is applied', async () => {
    vi.useFakeTimers();
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager();
    const current = {
      ...entry('worker'),
      agentSessionId: 'session-a',
      jsonlPath: '/tmp/session-a.jsonl',
      lastUserMessage: 'old prompt',
    };
    manager.registerTab('worker', current);

    manager.markAgentLaunch('worker', { resumeSessionId: 'session-b' });
    expect(current).toMatchObject({
      agentSessionId: 'session-a',
      jsonlPath: '/tmp/session-a.jsonl',
      lastUserMessage: 'old prompt',
    });

    manager.applyConfirmedCodexLaunch('worker', 'codex-generation', 'session-b');
    expect(current).toMatchObject({
      agentSessionId: 'session-b',
      jsonlPath: null,
      lastUserMessage: null,
    });
  });

  it('serializes overlapping liveness outcomes and retains both nudge records', async () => {
    const releaseFirst = deferred<void>();
    const paste = vi.fn(async (_session: string, message: string) => {
      if (message.includes('job-1')) await releaseFirst.promise;
    });
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_workspaceId, id) => tab(id)),
      withPolicyLock: policyLock(vi.fn(async () => ({ ok: true as const }))),
      hasSession: vi.fn(async () => true),
      paste,
    });
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(dispatcher);
    manager.registerTab('worker', entry('worker'));
    manager.registerTab('root', entry('root'));
    const handle = (manager as unknown as {
      handleLivenessEvent: (event: TLivenessEvent) => Promise<void>;
    }).handleLivenessEvent.bind(manager);

    const first = handle(completed(1));
    const second = handle(completed(2));
    await vi.waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(paste).toHaveBeenCalledTimes(2);
    expect(paste.mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining('job-1'),
      expect.stringContaining('job-2'),
    ]);
    expect(manager.getOrchestrationNudges('ws-1')).toEqual([
      expect.objectContaining({ kind: 'bg-completed', delivered: true }),
      expect.objectContaining({ kind: 'bg-completed', delivered: true }),
    ]);
  });

  it('records model drift for the human while policy blocks terminal delivery', async () => {
    const paste = vi.fn(async () => {});
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_workspaceId, id) => tab(id)),
      withPolicyLock: policyLock(vi.fn(async () => ({ ok: false as const, error: 'agent-model-mismatch' }))),
      hasSession: vi.fn(async () => true),
      paste,
    });
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(dispatcher);
    manager.registerTab('root', entry('root'));
    const nudge = (manager as unknown as {
      nudgeLiveness: (workspaceId: string, tabId: string, tabName: string, kind: 'model-drift', detail: string) => Promise<boolean>;
    }).nudgeLiveness.bind(manager);

    await expect(nudge('ws-1', 'root', 'root', 'model-drift', 'expected astra, observed sol')).resolves.toBe(false);

    expect(paste).not.toHaveBeenCalled();
    expect(manager.getOrchestrationNudges('ws-1')).toEqual([
      expect.objectContaining({ kind: 'model-drift', delivered: false }),
    ]);
  });

  it('guards a kickoff at its final delivery point', async () => {
    vi.useFakeTimers();
    const paste = vi.fn(async () => {});
    const checkPolicy = vi.fn(async () => ({ ok: true as const }));
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_workspaceId, id) => tab(id)),
      withPolicyLock: policyLock(checkPolicy),
      hasSession: vi.fn(async () => true),
      paste,
    });
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(dispatcher);
    manager.registerTab('root', entry('root'));

    manager.queueKickoffPrompt('root', 'start orchestration');
    await vi.advanceTimersByTimeAsync(KICKOFF_FALLBACK_DELAY_MS + 800);

    expect(checkPolicy).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ id: 'root' }),
      { consumeBootstrapForTarget: true },
    );
    expect(paste).toHaveBeenCalledWith('tmux-root', 'start orchestration');
  });

  it.each(['root', 'worker-terminal'])('suppresses heartbeats for a live job on %s and starts a fresh idle episode after it exits', async (jobTabId) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    let jobAlive = true;
    liveness.statusForTab.mockImplementation(async (tabId: string) => ({
      probes: [],
      backgroundJobs: tabId === jobTabId
        ? [{ pid: 878382, label: 'review', alive: jobAlive, registeredAt: Date.now(), ageS: 0 }]
        : [],
    }));
    const paste = vi.fn(async () => {});
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_workspaceId, id) => tab(id)),
      withPolicyLock: policyLock(vi.fn(async () => ({ ok: true as const }))),
      hasSession: vi.fn(async () => true),
      paste,
    });
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(dispatcher);
    manager.registerTab('root', entry('root'));
    if (jobTabId === 'worker-terminal') {
      manager.registerTab('worker-terminal', { ...entry('worker-terminal'), panelType: 'terminal' });
    }
    const runKeeper = (manager as unknown as {
      runOrchestratorKeeper: () => Promise<void>;
    }).runOrchestratorKeeper.bind(manager);

    await runKeeper();
    await vi.advanceTimersByTimeAsync(ORCH_IDLE_HEARTBEAT_MS + 60_000);
    await runKeeper();
    expect(paste).not.toHaveBeenCalled();

    jobAlive = false;
    await runKeeper();
    expect(paste).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ORCH_IDLE_HEARTBEAT_MS);
    await runKeeper();
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it('does not let a dead registered job suppress the keeper', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    liveness.statusForTab.mockResolvedValue({
      probes: [],
      backgroundJobs: [{ pid: 878382, label: 'old-review', alive: false, registeredAt: 0, ageS: 900 }],
    });
    const paste = vi.fn(async () => {});
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_workspaceId, id) => tab(id)),
      withPolicyLock: policyLock(vi.fn(async () => ({ ok: true as const }))),
      hasSession: vi.fn(async () => true),
      paste,
    });
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(dispatcher);
    manager.registerTab('root', entry('root'));
    const runKeeper = (manager as unknown as {
      runOrchestratorKeeper: () => Promise<void>;
    }).runOrchestratorKeeper.bind(manager);

    await runKeeper();
    await vi.advanceTimersByTimeAsync(ORCH_IDLE_HEARTBEAT_MS);
    await runKeeper();

    expect(paste).toHaveBeenCalledTimes(1);
  });
});
