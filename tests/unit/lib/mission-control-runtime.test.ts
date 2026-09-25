import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IWorkspaceStandup } from '@/types/status';
import type { ILayoutData, IWorkspace } from '@/types/terminal';

const mocks = vi.hoisted(() => ({
  workspaces: [] as IWorkspace[],
  layout: null as ILayoutData | null,
  standups: [] as IWorkspaceStandup[],
  statuses: {} as Record<string, Record<string, unknown>>,
  panes: new Map<string, { command: string; path: string; pid: number; windowActivity: number }>(),
  getWorkspaces: vi.fn(),
  readLayoutFile: vi.fn(),
  readStandups: vi.fn(),
  getAllPanesInfo: vi.fn(),
  findTab: vi.fn(),
  capture: vi.fn(),
  deliverPrompt: vi.fn(),
  agentRunning: true,
}));

vi.mock('@/lib/cli-utils', () => ({ findTab: mocks.findTab }));
vi.mock('@/lib/capture-at-width', () => ({ capturePaneAtWidth: mocks.capture }));
vi.mock('@/lib/agent-prompt-delivery', () => ({ deliverPrompt: mocks.deliverPrompt }));
vi.mock('@/lib/agent-dispatch-policy', () => ({
  withAgentDispatchLock: async (
    _workspaceId: string,
    _tab: unknown,
    work: (check: () => Promise<{ ok: true }>) => Promise<unknown>,
  ) => work(async () => ({ ok: true as const })),
}));

vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: mocks.getWorkspaces,
}));

vi.mock('@/lib/layout-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/layout-store')>('@/lib/layout-store');
  return {
    ...actual,
    readLayoutFile: mocks.readLayoutFile,
    resolveLayoutFile: (workspaceId: string) => `/data/${workspaceId}/layout.json`,
  };
});

vi.mock('@/lib/standup-store', () => ({ readStandups: mocks.readStandups }));
vi.mock('@/lib/tmux', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tmux')>('@/lib/tmux');
  return { ...actual, getAllPanesInfo: mocks.getAllPanesInfo };
});
vi.mock('@/lib/process-utils', () => ({ getChildPids: vi.fn(async () => []) }));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ getAllForClient: () => mocks.statuses }),
}));
vi.mock('@/lib/providers/registry', () => ({
  getProviderByPanelType: (panelType: string | undefined) => panelType === 'claude-code'
    ? {
        id: 'claude',
        matchesProcess: (command: string) => command === 'claude',
        isAgentRunning: vi.fn(async () => mocks.agentRunning),
        isValidSessionId: (value: unknown) => typeof value === 'string' && value.length > 0,
      }
    : null,
}));

import {
  discoverMissionControlWorkspaces,
  dispatchMissionPrompt,
  hasEmptyAgentComposer,
  missionLiveRunSourceKey,
  MissionControlRuntime,
  type IMissionControlRuntimeStore,
  type IMissionRuntimeDeps,
} from '@/lib/mission-control-runtime';
import type {
  IMissionBinding,
  IMissionBootstrapEntry,
  IMissionDelivery,
  IMissionSnapshot,
} from '@/types/mission-control';

const NOW = 2_000_000_000_000;

const standup = (overrides: Partial<IWorkspaceStandup> = {}): IWorkspaceStandup => ({
  workspaceId: 'ws-one',
  at: NOW,
  state: 'done',
  headline: 'Implementation reported complete',
  items: [],
  blockers: [],
  needsHuman: false,
  next: ['Run closeout'],
  ...overrides,
});

describe('Mission Control runtime discovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.workspaces = [{
      id: 'ws-one',
      name: 'One',
      directories: ['/repo'],
      orchestration: { enabled: false, orchestratorTabId: 'orch' },
    }];
    mocks.layout = {
      root: {
        type: 'pane',
        id: 'pane-one',
        activeTabId: 'orch',
        tabs: [
          { id: 'orch', sessionName: 'pt-ws-one-pane-orch', name: 'orchestrator', order: 0, panelType: 'claude-code' },
          { id: 'worker', sessionName: 'pt-ws-one-pane-worker', name: 'worker', order: 1, panelType: 'claude-code' },
        ],
      },
      activePaneId: 'pane-one',
      updatedAt: new Date(NOW).toISOString(),
    };
    mocks.statuses = {
      orch: { workspaceId: 'ws-one', agentProviderId: 'claude', agentSessionId: 'session-orch', cliState: 'idle' },
      worker: { workspaceId: 'ws-one', agentProviderId: 'claude', agentSessionId: 'session-worker', cliState: 'busy', busySince: NOW - 1_000 },
    };
    mocks.panes = new Map([
      ['pt-ws-one-pane-orch', { command: 'claude', path: '/repo', pid: 10, windowActivity: NOW / 1_000 - 10 }],
      ['pt-ws-one-pane-worker', { command: 'claude', path: '/repo', pid: 11, windowActivity: NOW / 1_000 - 1 }],
    ]);
    mocks.standups = [standup({ blockers: [{ what: 'Old choice', needs: 'Choose A or B' }] })];
    mocks.agentRunning = true;
    mocks.capture.mockResolvedValue('completed\n❯\u00a0');
    mocks.deliverPrompt.mockResolvedValue(undefined);
    mocks.findTab.mockImplementation(async () => ({ tab: mocks.layout?.root.type === 'pane' ? mocks.layout.root.tabs[0] : null }));
    mocks.getWorkspaces.mockResolvedValue({ workspaces: mocks.workspaces, groups: [], sidebarCollapsed: false, sidebarWidth: 220 });
    mocks.readLayoutFile.mockImplementation(async () => mocks.layout);
    mocks.readStandups.mockImplementation(async () => mocks.standups);
    mocks.getAllPanesInfo.mockImplementation(async () => mocks.panes);
  });

  it('keeps a workspace active for a busy worker when its orchestrator is idle and disabled', async () => {
    const [workspace] = await discoverMissionControlWorkspaces();

    expect(workspace.activity).toBe('active');
    expect(workspace.reconciliation?.binding).toMatchObject({
      tabId: 'orch',
      providerId: 'claude',
      sessionId: 'session-orch',
    });
    expect(workspace.run).toMatchObject({ state: 'running', phase: 'done' });
    expect(workspace.candidates).toHaveLength(1);
    expect(workspace.candidates[0].evidence.confidence).toBe('provisional');
  });

  it('does not revive an older question that disappeared from the latest standup', async () => {
    mocks.standups = [
      standup({ at: NOW, headline: 'Decision applied', blockers: [] }),
      standup({ at: NOW - 1_000, headline: 'Waiting', blockers: [{ what: 'Choose', needs: 'A or B' }] }),
    ];

    const [workspace] = await discoverMissionControlWorkspaces();
    expect(workspace.candidates).toEqual([]);
  });

  it('does not count live idle agent tabs as active work', async () => {
    mocks.statuses.worker.cliState = 'idle';
    mocks.standups = [];

    const [workspace] = await discoverMissionControlWorkspaces();
    expect(workspace.activity).toBe('dormant');
    expect(workspace.run?.objective).toBe('Unknown current objective');
  });

  it('does not treat a background agent under a shell foreground as verified live work', async () => {
    mocks.standups = [];
    mocks.panes.set('pt-ws-one-pane-orch', {
      command: 'bash', path: '/repo', pid: 10, windowActivity: NOW / 1_000,
    });
    mocks.panes.set('pt-ws-one-pane-worker', {
      command: 'bash', path: '/repo', pid: 11, windowActivity: NOW / 1_000,
    });

    const [workspace] = await discoverMissionControlWorkspaces();

    expect(workspace.agents.every((agent) => !agent.alive)).toBe(true);
    expect(workspace.run).toBeNull();
  });

  it('keeps a stale standup as provenance without inventing a current running run', async () => {
    mocks.agentRunning = false;
    mocks.standups = [standup({
      at: NOW - 24 * 60 * 60_000,
      state: 'awaiting-human',
      blockers: [{ what: 'Historical choice', needs: 'Confirm whether this is still relevant' }],
    })];

    const [workspace] = await discoverMissionControlWorkspaces();

    expect(workspace.activity).toBe('dormant');
    expect(workspace.run).toBeNull();
    expect(workspace.candidates).toHaveLength(1);
    expect(workspace.candidates[0].evidence).toMatchObject({ source: 'standup', confidence: 'provisional' });
  });

  it('uses unknown current semantics when a live session has only stale standup history', async () => {
    mocks.standups = [standup({
      at: NOW - 24 * 60 * 60_000,
      state: 'awaiting-human',
      headline: 'Old objective must not look current',
      next: ['Old next step'],
      blockers: [{ what: 'Historical choice', needs: 'Confirm whether this is still relevant' }],
    })];

    const [workspace] = await discoverMissionControlWorkspaces();

    expect(workspace.activity).toBe('active');
    expect(workspace.run).toMatchObject({
      objective: 'Unknown current objective',
      phase: null,
      nextStep: null,
      lastProgressAt: null,
      evidence: { source: 'bootstrap', confidence: 'unknown' },
    });
    expect(workspace.run?.sourceKey).not.toContain('standup');
    expect(workspace.candidates).toHaveLength(1);
  });

  it('uses a new live source when a provider session is replaced after an earlier lifecycle', async () => {
    mocks.standups = [];
    const [first] = await discoverMissionControlWorkspaces();

    mocks.statuses.orch.agentSessionId = 'session-orch-two';
    const [second] = await discoverMissionControlWorkspaces();

    expect(first.run?.sourceKey).not.toBe(second.run?.sourceKey);
    expect(first.identities).toContainEqual(expect.objectContaining({
      tabId: 'orch', sessionId: 'session-orch',
    }));
    expect(second.identities).toContainEqual(expect.objectContaining({
      tabId: 'orch', sessionId: 'session-orch-two',
    }));
  });

  it('does not treat a repeated standup heartbeat as recent progress', async () => {
    mocks.agentRunning = false;
    const repeated = {
      state: 'awaiting-human' as const,
      headline: 'Historical choice is still waiting',
      blockers: [{ what: 'Historical choice', needs: 'Confirm whether this is still relevant' }],
    };
    mocks.standups = [
      standup({ ...repeated, at: NOW - 1_000 }),
      standup({ ...repeated, at: NOW - 10 * 60_000 }),
      standup({ ...repeated, at: NOW - 24 * 60 * 60_000 }),
    ];

    const [workspace] = await discoverMissionControlWorkspaces();

    expect(workspace.activity).toBe('dormant');
    expect(workspace.run).toBeNull();
    expect(workspace.lastProgressAt).toBe(NOW - 24 * 60 * 60_000);
    expect(workspace.candidates).toHaveLength(1);
  });
});

describe('Mission Control live lifecycle identity', () => {
  const orchestrator = {
    tabId: 'orch', providerId: 'claude', sessionId: 'session-orch', runtimeGeneration: null,
  };
  const worker = {
    tabId: 'worker', providerId: 'codex', sessionId: 'session-worker', runtimeGeneration: 'launch-one',
  };

  it('is stable across identity ordering and duplicates', () => {
    const source = missionLiveRunSourceKey('ws-one', [orchestrator, worker]);
    expect(missionLiveRunSourceKey('ws-one', [worker, orchestrator, worker])).toBe(source);
  });

  it.each([
    ['provider', { ...worker, providerId: 'grok' }],
    ['session', { ...worker, sessionId: 'session-two' }],
    ['launch', { ...worker, runtimeGeneration: 'launch-two' }],
  ])('changes when the %s identity changes', (_field, changed) => {
    expect(missionLiveRunSourceKey('ws-one', [orchestrator, changed]))
      .not.toBe(missionLiveRunSourceKey('ws-one', [orchestrator, worker]));
  });
});

describe('Mission Control composer guard', () => {
  it('accepts the latest empty composer', () => {
    expect(hasEmptyAgentComposer('claude-code', 'completed output\n────────\n❯\u00a0\n────────')).toBe(true);
    expect(hasEmptyAgentComposer('codex-cli', 'completed output\n›   ')).toBe(true);
  });

  it('rejects a current draft even when scrollback contains an older empty composer', () => {
    const pane = [
      'old output',
      '❯\u00a0',
      'new output',
      '❯ do not overwrite this draft',
    ].join('\n');
    expect(hasEmptyAgentComposer('claude-code', pane)).toBe(false);
  });

  it('rejects multiline draft content after the current composer boundary', () => {
    const pane = ['› first line of draft', '  second line of draft'].join('\n');
    expect(hasEmptyAgentComposer('codex-cli', pane)).toBe(false);
  });
});

describe('Mission Control live delivery guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const tab = { id: 'orch', sessionName: 'pt-ws-one-pane-orch', name: 'orchestrator', order: 0, panelType: 'claude-code' as const };
    mocks.findTab.mockResolvedValue({ tab });
    mocks.statuses = {
      orch: {
        workspaceId: 'ws-one',
        agentProviderId: 'claude',
        agentSessionId: 'session-orch',
        cliState: 'idle',
        permissionRequest: null,
      },
    };
    mocks.panes = new Map([
      [tab.sessionName, { command: 'claude', path: '/repo', pid: 10, windowActivity: NOW / 1_000 }],
    ]);
    mocks.getAllPanesInfo.mockImplementation(async () => mocks.panes);
    mocks.agentRunning = true;
    mocks.capture.mockResolvedValue('completed\n❯\u00a0');
    mocks.deliverPrompt.mockResolvedValue(undefined);
  });

  it('submits once only after every binding and composer guard passes', async () => {
    const result = await dispatchMissionPrompt({ workspaceId: 'ws-one', binding, message: 'read answer' });

    expect(result).toEqual({ delivered: true });
    expect(mocks.deliverPrompt).toHaveBeenCalledOnce();
  });

  it('refuses a replaced provider session before terminal delivery', async () => {
    mocks.statuses.orch.agentSessionId = 'replacement-session';

    const result = await dispatchMissionPrompt({ workspaceId: 'ws-one', binding, message: 'read answer' });

    expect(result).toMatchObject({ delivered: false, retryable: false, reason: 'binding-identity-changed' });
    expect(mocks.deliverPrompt).not.toHaveBeenCalled();
  });

  it('refuses when the provider process is no longer live', async () => {
    mocks.agentRunning = false;

    const result = await dispatchMissionPrompt({ workspaceId: 'ws-one', binding, message: 'read answer' });

    expect(result).toMatchObject({ delivered: false, retryable: false, reason: 'bound-agent-not-live' });
    expect(mocks.deliverPrompt).not.toHaveBeenCalled();
  });

  it('refuses a shell foreground even when a descendant agent and stale composer remain observable', async () => {
    mocks.panes.set('pt-ws-one-pane-orch', {
      command: 'bash',
      path: '/repo',
      pid: 10,
      windowActivity: NOW / 1_000,
    });
    mocks.agentRunning = true;
    mocks.capture.mockResolvedValue('stale agent output\n❯\u00a0');

    const result = await dispatchMissionPrompt({ workspaceId: 'ws-one', binding, message: 'read answer' });

    expect(result).toMatchObject({ delivered: false, retryable: false, reason: 'bound-agent-not-live' });
    expect(mocks.deliverPrompt).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('defers native prompts and user composer drafts without typing', async () => {
    mocks.statuses.orch.permissionRequest = { id: 'permission-one' };
    const nativePrompt = await dispatchMissionPrompt({ workspaceId: 'ws-one', binding, message: 'read answer' });
    expect(nativePrompt).toMatchObject({ delivered: false, retryable: true, reason: 'native-prompt-active' });

    mocks.statuses.orch.permissionRequest = null;
    mocks.capture.mockResolvedValue('old\n❯\u00a0\nnew\n❯ existing draft');
    const draft = await dispatchMissionPrompt({ workspaceId: 'ws-one', binding, message: 'read answer' });
    expect(draft).toMatchObject({ delivered: false, retryable: true, reason: 'composer-not-empty' });
    expect(mocks.deliverPrompt).not.toHaveBeenCalled();
  });

  it('runs the durable eligibility preflight immediately before terminal delivery', async () => {
    const order: string[] = [];
    mocks.deliverPrompt.mockImplementation(async () => {
      order.push('deliver');
    });

    const result = await dispatchMissionPrompt({
      workspaceId: 'ws-one',
      binding,
      message: 'read answer',
      preflight: () => {
        order.push('preflight');
        return { ok: true };
      },
    });

    expect(result).toEqual({ delivered: true });
    expect(order).toEqual(['preflight', 'deliver']);
  });

  it('does not paste when the durable record changed after dispatch guards passed', async () => {
    const result = await dispatchMissionPrompt({
      workspaceId: 'ws-one',
      binding,
      message: 'read answer',
      preflight: () => ({ ok: false, reason: 'run-binding-changed' }),
    });

    expect(result).toEqual({
      delivered: false,
      retryable: false,
      uncertain: false,
      reason: 'dispatch-ineligible:run-binding-changed',
    });
    expect(mocks.deliverPrompt).not.toHaveBeenCalled();
  });
});

const binding: IMissionBinding = {
  tabId: 'orch',
  providerId: 'claude',
  sessionId: 'session-orch',
  generation: 2,
  runtimeGeneration: null,
};

const delivery = (overrides: Partial<IMissionDelivery> = {}): IMissionDelivery => ({
  id: 'delivery-one',
  answerId: 'answer-one',
  workspaceId: 'ws-one',
  runId: 'run-one',
  binding,
  state: 'queued',
  attempts: 0,
  nextAttemptAt: NOW,
  lastError: null,
  submittedAt: null,
  acknowledgedAt: null,
  updatedAt: 1,
  ...overrides,
});

const snapshot = (runBinding: IMissionBinding | null = binding, runRevision = 4): IMissionSnapshot => ({
  schemaVersion: 1,
  cursor: 3,
  generatedAt: NOW,
  workspaces: [],
  runs: [{
    id: 'run-one',
    workspaceId: 'ws-one',
    revision: runRevision,
    objective: 'Ship it',
    epic: null,
    phase: 'implementation',
    state: 'running',
    nextStep: null,
    binding: runBinding,
    evidence: { source: 'agent', sourceId: 'event-one', observedAt: NOW, confidence: 'confirmed' },
    closeoutPending: false,
    storyCounts: null,
    lastProgressAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }],
  items: [{
    id: 'item-one',
    workspaceId: 'ws-one',
    runId: 'run-one',
    revision: 2,
    state: 'answered',
    kind: 'question',
    title: 'Choose',
    context: 'A or B',
    storyIds: [],
    options: [],
    recommendation: null,
    blockingScope: 'story',
    canContinue: true,
    evidence: { source: 'agent', sourceId: 'event-two', observedAt: NOW, confidence: 'confirmed' },
    answerId: 'answer-one',
    resolution: null,
    createdAt: NOW,
    updatedAt: NOW,
  }],
  answers: [{
    id: 'answer-one',
    submissionId: 'submission-one',
    expectedRevision: 1,
    optionIds: [],
    text: 'A',
    actionCompleted: false,
    workspaceId: 'ws-one',
    runId: 'run-one',
    itemId: 'item-one',
    actor: 'human',
    createdAt: NOW,
  }],
  deliveries: [],
  recentEvents: [],
  bootstrap: null,
});

const runtimeHarness = (options: {
  due?: IMissionDelivery[];
  runBinding?: IMissionBinding | null;
  dispatchResult?: Awaited<ReturnType<IMissionRuntimeDeps['dispatch']>>;
  deliveryValidation?: { ok: true } | { ok: false; reason: string };
  bootstrapValidation?: { ok: true } | { ok: false; reason: string };
  bootstrap?: { entry: IMissionBootstrapEntry; attempts: number };
  runRevision?: number;
} = {}) => {
  const events: string[] = [];
  const claimed = delivery({
    ...(options.due?.[0] ?? {}),
    state: 'dispatching',
    attempts: (options.due?.[0]?.attempts ?? 0) + 1,
    updatedAt: 2,
  });
  const validateDeliveryAttempt = vi.fn(() => {
    events.push('validate-delivery');
    return options.deliveryValidation ?? { ok: true as const };
  });
  const finalizeDeliveryAttempt = vi.fn(() => claimed);
  const completeBootstrapAttempt = vi.fn(() => options.bootstrap?.entry ?? null);
  const store = {
    snapshot: vi.fn(() => snapshot(
      options.runBinding === undefined ? binding : options.runBinding,
      options.runRevision,
    )),
    reconcileDiscovery: vi.fn(),
    listDueDeliveries: vi.fn(() => options.due ?? []),
    claimDelivery: vi.fn(() => {
      events.push('claim');
      return claimed;
    }),
    validateDeliveryAttempt,
    finalizeDeliveryAttempt: vi.fn((...args: Parameters<typeof finalizeDeliveryAttempt>) => {
      events.push('complete');
      return finalizeDeliveryAttempt(...args);
    }),
    recoverDispatching: vi.fn(() => 0),
    listQueuedBootstrapEntries: vi.fn(() => options.bootstrap
      ? [{ bootstrapId: 'bootstrap-one', entry: options.bootstrap.entry, attempts: 0, nextAttemptAt: NOW }]
      : []),
    claimBootstrapEntry: vi.fn(() => options.bootstrap
      ? { bootstrapId: 'bootstrap-one', entry: { ...options.bootstrap.entry, state: 'dispatching', updatedAt: 2 }, attempts: options.bootstrap.attempts, nextAttemptAt: null }
      : null),
    validateBootstrapAttempt: vi.fn(() => {
      events.push('validate-bootstrap');
      return options.bootstrapValidation ?? { ok: true as const };
    }),
    completeBootstrapAttempt,
  } as unknown as IMissionControlRuntimeStore;
  const dispatch = vi.fn(async (_request: Parameters<IMissionRuntimeDeps['dispatch']>[0]) => {
    events.push('dispatch');
    const eligibility = _request.preflight?.();
    if (eligibility && !eligibility.ok) {
      return {
        delivered: false as const,
        retryable: false,
        uncertain: false,
        reason: `dispatch-ineligible:${eligibility.reason}`,
      };
    }
    return options.dispatchResult ?? { delivered: true as const };
  });
  const deps: IMissionRuntimeDeps = {
    getStore: () => store,
    now: () => NOW,
    discover: vi.fn(),
    workspaceViews: vi.fn(async () => []),
    resolveIdentity: vi.fn(),
    dispatch,
    setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
    clearInterval: vi.fn(),
  };
  return {
    runtime: new MissionControlRuntime(deps),
    store,
    deps,
    dispatch,
    validateDeliveryAttempt,
    finalizeDeliveryAttempt,
    completeBootstrapAttempt,
    events,
  };
};

describe('Mission Control durable delivery worker', () => {
  it('contains a rejected fire-and-forget worker pass after bootstrap succeeds', async () => {
    const harness = runtimeHarness();
    const bootstrap = { id: 'bootstrap-one', boundarySeq: 3, createdAt: NOW, entries: [] };
    vi.mocked(harness.store.reconcileDiscovery).mockReturnValue(bootstrap);
    vi.mocked(harness.store.listDueDeliveries).mockImplementation(() => {
      throw new Error('database unavailable after commit');
    });
    harness.deps.discover = vi.fn(async (bootstrapId, reconcile, boundarySeq) => ({
      bootstrapId,
      reconcile,
      boundarySeq,
      observedAt: NOW,
      workspaces: [],
    }));

    await expect(harness.runtime.bootstrap({ bootstrapId: 'bootstrap-one', reconcile: true }))
      .resolves.toEqual(bootstrap);
    await Promise.resolve();
  });

  it('keeps PurpleMux startup available and retries recovery after storage opens', async () => {
    const harness = runtimeHarness();
    let unavailable = true;
    harness.deps.getStore = () => {
      if (unavailable) throw new Error('database unavailable');
      return harness.store;
    };

    await expect(harness.runtime.start()).resolves.toBeUndefined();
    expect(harness.deps.setInterval).toHaveBeenCalledOnce();

    unavailable = false;
    await harness.runtime.tick();
    expect(harness.store.recoverDispatching).toHaveBeenCalledWith('server-restarted-during-uncertain-delivery');
  });

  it('claims before dispatch and durably schedules a bounded readiness retry', async () => {
    const queued = delivery();
    const harness = runtimeHarness({
      due: [queued],
      dispatchResult: { delivered: false, retryable: true, uncertain: false, reason: 'native-prompt-active' },
    });

    await harness.runtime.tick();

    expect(harness.events).toEqual(['claim', 'dispatch', 'validate-delivery', 'complete']);
    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 2, binding, {
      state: 'queued',
      nextAttemptAt: NOW + 5_000,
      lastError: 'native-prompt-active',
    });
  });

  it('holds an answer when its run binding changed and never dispatches it', async () => {
    const harness = runtimeHarness({
      due: [delivery()],
      runBinding: { ...binding, generation: 3 },
    });

    await harness.runtime.tick();

    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 2, binding, {
      state: 'held',
      nextAttemptAt: null,
      lastError: 'run-binding-changed',
    });
  });

  it('revalidates the durable delivery after claim and holds a concurrently invalidated send', async () => {
    const harness = runtimeHarness({
      due: [delivery()],
      deliveryValidation: { ok: false, reason: 'attention-no-longer-answered' },
    });

    await harness.runtime.tick();

    expect(harness.validateDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 2, binding);
    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 2, binding, {
      state: 'held',
      nextAttemptAt: null,
      lastError: 'dispatch-ineligible:attention-no-longer-answered',
    });
  });

  it('holds an uncertain transport outcome instead of automatically resending', async () => {
    const harness = runtimeHarness({
      due: [delivery()],
      dispatchResult: { delivered: false, retryable: false, uncertain: true, reason: 'transport-uncertain' },
    });

    await harness.runtime.tick();

    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 2, binding, {
      state: 'held',
      nextAttemptAt: null,
      lastError: 'transport-uncertain',
    });
  });

  it('keeps known pre-send deferrals queued with a capped backoff', async () => {
    const harness = runtimeHarness({
      due: [delivery({ attempts: 8 })],
      dispatchResult: { delivered: false, retryable: true, uncertain: false, reason: 'composer-not-ready:busy' },
    });

    await harness.runtime.tick();

    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 2, binding, {
      state: 'queued',
      nextAttemptAt: NOW + 60_000,
      lastError: 'composer-not-ready:busy',
    });
  });

  it('defers one-off bootstrap reconciliation until the composer is ready', async () => {
    const entry: IMissionBootstrapEntry = {
      workspaceId: 'ws-one',
      runId: 'run-one',
      binding: { ...binding, generation: 0 },
      state: 'queued',
      reason: null,
      updatedAt: 1,
    };
    const harness = runtimeHarness({
      bootstrap: { entry, attempts: 1 },
      runRevision: 0,
      dispatchResult: { delivered: false, retryable: true, uncertain: false, reason: 'composer-not-ready:busy' },
    });

    await harness.runtime.tick();

    expect(harness.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('First bind this provisional run by emitting run.resumed'),
    }));
    expect(harness.dispatch.mock.calls[0][0].message).toContain('expectedRevision 0, bindingGeneration 0');
    expect(harness.store.validateBootstrapAttempt).toHaveBeenCalledWith(
      'bootstrap-one',
      'ws-one',
      'run-one',
      2,
    );
    expect(harness.completeBootstrapAttempt).toHaveBeenCalledWith(
      'bootstrap-one',
      'ws-one',
      'run-one',
      2,
      {
        state: 'queued',
        reason: 'readiness-deferred:composer-not-ready:busy',
        nextAttemptAt: NOW + 5_000,
      },
    );
  });
});
