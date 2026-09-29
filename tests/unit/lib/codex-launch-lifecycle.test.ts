import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ITab } from '@/types/terminal';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const LAUNCHER = '/home/test/.purplemux/codex-launcher.js';

const mocks = vi.hoisted(() => ({
  tab: null as ITab | null,
  findTab: vi.fn(),
  findSession: vi.fn(),
  panePid: vi.fn(),
  children: vi.fn(),
  argv: vi.fn(),
  start: vi.fn(),
  running: vi.fn(),
  modelStatus: vi.fn(),
  beforeMutate: null as (() => void) | null,
}));

vi.mock('@/lib/cli-utils', () => ({ findTab: mocks.findTab }));
vi.mock('@/lib/layout-store', () => ({
  mutateTabAtomically: vi.fn(async (
    _workspaceId: string,
    tabId: string,
    mutator: (tab: ITab) => { changed: boolean; value: unknown },
  ) => {
    if (!mocks.tab || mocks.tab.id !== tabId) return { found: false };
    const beforeMutate = mocks.beforeMutate;
    mocks.beforeMutate = null;
    beforeMutate?.();
    const result = mutator(mocks.tab);
    return { found: true, value: result.value, tab: { ...mocks.tab } };
  }),
  parseSessionName: vi.fn(() => ({ wsId: 'ws-test', paneId: 'pane-p', tabId: 'tab-t' })),
}));
vi.mock('@/lib/providers/codex', () => ({
  CODEX_LAUNCHER_SCRIPT: '/home/test/.purplemux/codex-launcher.js',
  codexProvider: {
    isValidSessionId: (value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
    readSessionId: (tab: ITab) => tab.agentState?.providerId === 'codex' ? tab.agentState.sessionId : null,
    readJsonlPath: (tab: ITab) => tab.agentState?.providerId === 'codex' ? tab.agentState.jsonlPath : null,
    writeSessionId: (tab: ITab, value: string | null) => {
      tab.agentState = { providerId: 'codex', sessionId: value, jsonlPath: null, summary: null };
    },
    writeJsonlPath: (tab: ITab, value: string | null) => { if (tab.agentState) tab.agentState.jsonlPath = value; },
    writeSummary: (tab: ITab, value: string | null) => { if (tab.agentState) tab.agentState.summary = value; },
  },
}));
vi.mock('@/lib/providers/codex/session-detection', () => ({ findCodexSessionById: mocks.findSession }));
vi.mock('@/lib/tmux', () => ({ getSessionPanePid: mocks.panePid }));
vi.mock('@/lib/process-utils', () => ({
  getChildPids: mocks.children,
  getProcessArgv: mocks.argv,
  getProcessStartTimeMs: mocks.start,
  isProcessRunning: mocks.running,
}));
vi.mock('@/lib/providers/codex/model-observation', () => ({ getCodexModelStatus: mocks.modelStatus }));

import {
  beginCodexLaunch,
  claimCodexBootstrap,
  confirmCodexLaunchReceipt,
  markCodexLaunchSubmitted,
  reconcileCodexLaunchTimeout,
  resolveCodexLaunchIntent,
  validateCodexHookGeneration,
  withCodexTargetLock,
  withReplayedCodexHookGeneration,
  withValidatedCodexHookGeneration,
  withValidatedLegacyCodexHook,
} from '@/lib/providers/codex/launch-lifecycle';

const makeTab = (): ITab => ({
  id: 'tab-t',
  sessionName: 'pt-ws-test-pane-p-tab-t',
  name: 'worker',
  order: 0,
  panelType: 'codex-cli',
  agentState: {
    providerId: 'codex',
    sessionId: '22222222-2222-4222-8222-222222222222',
    jsonlPath: '/old/a.jsonl',
    summary: 'old summary',
  },
  lastUserMessage: 'old prompt',
  agentLaunchConfig: { model: 'gpt-6-astra', effort: 'high' },
});

/** A server that tracks no launch in memory for the tab (e.g. since its restart). */
const untracked = () => null;

const installValidProcessTree = (generation: string, resume = true): void => {
  mocks.panePid.mockResolvedValue(10);
  mocks.children.mockImplementation(async (pid: number) => pid === 10 ? [20] : pid === 20 ? [30] : []);
  mocks.argv.mockImplementation(async (pid: number) => pid === 20
    ? ['node', LAUNCHER, '--generation', generation, '--workspace-id', 'ws-test', '--tab-id', 'tab-t', '--session-name', 'pt-ws-test-pane-p-tab-t']
    : pid === 30
      ? ['codex', ...(resume ? ['resume', SESSION_ID] : []), '--model', 'gpt-6-astra', '-c', 'model_reasoning_effort=high']
      : ['bash']);
  mocks.start.mockImplementation(async (pid: number) => pid * 1_000);
  mocks.running.mockResolvedValue(true);
};

describe('Codex managed launch lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.beforeMutate = null;
    mocks.tab = makeTab();
    mocks.findTab.mockImplementation(async () => mocks.tab
      ? { workspaceId: 'ws-test', paneId: 'pane-p', tab: mocks.tab }
      : null);
    mocks.findSession.mockResolvedValue(null);
    mocks.modelStatus.mockResolvedValue({
      expected: { model: 'gpt-6-astra', effort: 'high' },
      observed: null,
      latestTurn: null,
      latestSettings: null,
      scanState: 'complete',
      hasActivity: false,
      status: 'unknown',
      reason: 'awaiting-first-turn',
    });
  });

  it('persists an immutable prepared intent before resolving launcher arguments', async () => {
    const prepared = await beginCodexLaunch('ws-test', 'tab-t', { resumeSessionId: SESSION_ID });
    expect(prepared).toMatchObject({
      ok: true,
      state: 'prepared',
      intent: {
        workspaceId: 'ws-test',
        tabId: 'tab-t',
        sessionName: 'pt-ws-test-pane-p-tab-t',
        resumeSessionId: SESSION_ID,
        launchedConfig: { model: 'gpt-6-astra', effort: 'high' },
      },
    });
    if (!prepared.ok) throw new Error('expected prepared launch');
    mocks.tab!.agentLaunchConfig = { model: 'gpt-5.6-luna', effort: 'medium' };

    expect(await resolveCodexLaunchIntent(
      'ws-test',
      'tab-t',
      prepared.intent.generation,
      prepared.intent.sessionName,
    )).toMatchObject({ launchedConfig: { model: 'gpt-6-astra', effort: 'high' } });
    expect(await resolveCodexLaunchIntent(
      'ws-test',
      'tab-t',
      prepared.intent.generation,
      'wrong-session',
    )).toBeNull();
  });

  it.each(['terminal', 'agent-sessions'] as const)(
    'atomically changes an allowed %s surface when managed begin requests it',
    async (panelType) => {
      mocks.tab!.panelType = panelType;

      const prepared = await beginCodexLaunch('ws-test', 'tab-t', {
        transitionToCodexPanel: true,
      });

      expect(prepared).toMatchObject({ ok: true, state: 'prepared' });
      expect(mocks.tab).toMatchObject({
        panelType: 'codex-cli',
        codexLaunchRuntime: { pending: { phase: 'prepared' } },
      });
    },
  );

  it('rejects managed panel transition from a non-terminal surface', async () => {
    mocks.tab!.panelType = 'web-browser';

    expect(await beginCodexLaunch('ws-test', 'tab-t', {
      transitionToCodexPanel: true,
    })).toEqual({ ok: false, state: 'invalid', reason: 'not-codex-tab' });
    expect(mocks.tab!.panelType).toBe('web-browser');
    expect(mocks.tab!.codexLaunchRuntime).toBeUndefined();
  });

  it('activates only the exact submitted generation and clears stale binding atomically', async () => {
    const prepared = await beginCodexLaunch('ws-test', 'tab-t', { resumeSessionId: SESSION_ID });
    if (!prepared.ok) throw new Error('expected prepared launch');
    installValidProcessTree(prepared.intent.generation);
    expect(await markCodexLaunchSubmitted('ws-test', 'tab-t', prepared.intent.generation)).toMatchObject({
      ok: true,
      state: 'submitted',
    });

    const confirmed = await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test',
      tabId: 'tab-t',
      generation: prepared.intent.generation,
      launcherPid: 20,
      childPid: 30,
    });
    expect(confirmed).toMatchObject({ ok: true, state: 'confirmed' });
    expect(mocks.tab).toMatchObject({
      agentState: { sessionId: SESSION_ID, jsonlPath: null, summary: null },
      lastUserMessage: null,
      codexLaunchRuntime: {
        active: { generation: prepared.intent.generation, bootstrap: 'unused', phase: 'active' },
      },
    });
    expect(mocks.tab!.codexLaunchRuntime?.pending).toBeUndefined();

    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test',
      tabId: 'tab-t',
      generation: prepared.intent.generation,
      launcherPid: 20,
      childPid: 30,
    })).toMatchObject({ ok: true, state: 'duplicate' });
    expect(mocks.tab!.codexLaunchRuntime?.active?.bootstrap).toBe('unused');
  });

  it('revalidates only the identical held runtime after a transient identity read', async () => {
    const prepared = await beginCodexLaunch('ws-test', 'tab-t', { resumeSessionId: SESSION_ID });
    if (!prepared.ok) throw new Error('expected prepared launch');
    installValidProcessTree(prepared.intent.generation);
    await markCodexLaunchSubmitted('ws-test', 'tab-t', prepared.intent.generation);
    await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 20, childPid: 30,
    });
    const active = mocks.tab!.codexLaunchRuntime!.active!;
    active.phase = 'held';
    active.heldReason = 'process-identity-unavailable';
    active.bootstrap = 'consumed';
    mocks.tab!.agentState!.jsonlPath = '/sessions/current.jsonl';
    mocks.tab!.agentState!.summary = 'current summary';
    mocks.tab!.lastUserMessage = 'current prompt';
    const before = JSON.parse(JSON.stringify(mocks.tab)) as ITab;
    mocks.start.mockClear();
    let launcherReads = 0;
    mocks.start.mockImplementation(async (pid: number) => {
      if (pid === 20 && launcherReads++ === 0) return null;
      return pid * 1_000;
    });

    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 20, childPid: 30,
    })).toMatchObject({ ok: true, state: 'revalidated' });
    expect(mocks.start.mock.calls.filter(([pid]) => pid === 20)).toHaveLength(2);
    const expectedActive = { ...before.codexLaunchRuntime!.active! };
    expectedActive.phase = 'active';
    delete expectedActive.heldReason;
    expect(mocks.tab!.agentState).toEqual(before.agentState);
    expect(mocks.tab!.agentLaunchConfig).toEqual(before.agentLaunchConfig);
    expect(mocks.tab!.lastUserMessage).toBe(before.lastUserMessage);
    expect(mocks.tab!.codexLaunchRuntime!.active).toEqual(expectedActive);
    expect(mocks.tab!.codexLaunchRuntime!.active!.heldReason).toBeUndefined();
  });

  it('keeps persistent identity failure held and does not retry negative identity proof', async () => {
    const prepared = await beginCodexLaunch('ws-test', 'tab-t');
    if (!prepared.ok) throw new Error('expected prepared launch');
    installValidProcessTree(prepared.intent.generation, false);
    await markCodexLaunchSubmitted('ws-test', 'tab-t', prepared.intent.generation);
    await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 20, childPid: 30,
    });
    const active = mocks.tab!.codexLaunchRuntime!.active!;
    active.phase = 'held';
    active.heldReason = 'process-identity-unavailable';
    mocks.start.mockClear();
    mocks.start.mockImplementation(async (pid: number) => pid === 20 ? null : pid * 1_000);

    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 20, childPid: 30,
    })).toEqual({ ok: false, state: 'held', reason: 'process-identity-unavailable' });
    expect(mocks.start.mock.calls.filter(([pid]) => pid === 20)).toHaveLength(5);
    expect(active.phase).toBe('held');

    mocks.start.mockClear();
    mocks.start.mockImplementation(async (pid: number) => pid === 20 ? 99_999 : pid * 1_000);
    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 20, childPid: 30,
    })).toEqual({ ok: false, state: 'held', reason: 'process-identity-replaced' });
    expect(mocks.start.mock.calls.filter(([pid]) => pid === 20)).toHaveLength(1);
    expect(active.phase).toBe('held');
  });

  it('rejects held recovery for wrong identity, pending launch, and non-recoverable holds', async () => {
    const prepared = await beginCodexLaunch('ws-test', 'tab-t');
    if (!prepared.ok) throw new Error('expected prepared launch');
    installValidProcessTree(prepared.intent.generation, false);
    await markCodexLaunchSubmitted('ws-test', 'tab-t', prepared.intent.generation);
    await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 20, childPid: 30,
    });
    const active = mocks.tab!.codexLaunchRuntime!.active!;
    active.phase = 'held';
    active.heldReason = 'process-identity-unavailable';

    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: 'wrong-generation',
      launcherPid: 20, childPid: 30,
    })).toMatchObject({ ok: false, state: 'stale' });
    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 21, childPid: 30,
    })).toEqual({ ok: false, state: 'stale', reason: 'receipt-process-identity-mismatch' });

    mocks.tab!.codexLaunchRuntime!.pending = {
      generation: 'new-generation', workspaceId: 'ws-test', tabId: 'tab-t',
      sessionName: mocks.tab!.sessionName, resumeSessionId: null, launchedConfig: {},
      observationBoundary: null, priorLauncher: null, priorAgent: null,
      phase: 'prepared', preparedAt: new Date().toISOString(),
    };
    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 20, childPid: 30,
    })).toMatchObject({ ok: false, state: 'stale' });

    delete mocks.tab!.codexLaunchRuntime!.pending;
    active.heldReason = 'process-lineage-mismatch';
    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 20, childPid: 30,
    })).toEqual({ ok: false, state: 'held', reason: 'process-lineage-mismatch' });
  });

  it('fails the held-runtime CAS when policy or binding changes during proof', async () => {
    const prepared = await beginCodexLaunch('ws-test', 'tab-t');
    if (!prepared.ok) throw new Error('expected prepared launch');
    installValidProcessTree(prepared.intent.generation, false);
    await markCodexLaunchSubmitted('ws-test', 'tab-t', prepared.intent.generation);
    await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 20, childPid: 30,
    });
    const active = mocks.tab!.codexLaunchRuntime!.active!;
    active.phase = 'held';
    active.heldReason = 'process-identity-unavailable';
    mocks.tab!.agentState!.jsonlPath = '/sessions/current.jsonl';
    mocks.beforeMutate = () => {
      mocks.tab!.agentLaunchConfig = { model: 'gpt-5.6-sol', effort: 'high' };
      mocks.tab!.agentState!.jsonlPath = '/sessions/replaced.jsonl';
    };

    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 20, childPid: 30,
    })).toEqual({ ok: false, state: 'stale', reason: 'launch-runtime-changed' });
    expect(active.phase).toBe('held');
  });

  it.each([
    ['launcher argv', 'launcher-identity-mismatch'],
    ['pane lineage', 'process-lineage-mismatch'],
    ['competing process', 'competing-agent-process'],
  ])('keeps recovery held when %s no longer matches', async (failure, reason) => {
    const prepared = await beginCodexLaunch('ws-test', 'tab-t');
    if (!prepared.ok) throw new Error('expected prepared launch');
    installValidProcessTree(prepared.intent.generation, false);
    await markCodexLaunchSubmitted('ws-test', 'tab-t', prepared.intent.generation);
    await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 20, childPid: 30,
    });
    const active = mocks.tab!.codexLaunchRuntime!.active!;
    active.phase = 'held';
    active.heldReason = 'process-identity-unavailable';

    if (failure === 'launcher argv') {
      mocks.argv.mockImplementation(async (pid: number) => pid === 20
        ? ['node', LAUNCHER, '--generation', 'wrong-generation']
        : pid === 30
          ? ['codex', '--model', 'gpt-6-astra', '-c', 'model_reasoning_effort=high']
          : ['bash']);
    } else if (failure === 'pane lineage') {
      mocks.children.mockImplementation(async (pid: number) => pid === 10 ? [20] : []);
    } else {
      mocks.children.mockImplementation(async (pid: number) => pid === 10
        ? [20, 40]
        : pid === 20
          ? [30]
          : []);
      mocks.argv.mockImplementation(async (pid: number) => pid === 20
        ? ['node', LAUNCHER, '--generation', prepared.intent.generation, '--workspace-id', 'ws-test', '--tab-id', 'tab-t', '--session-name', 'pt-ws-test-pane-p-tab-t']
        : pid === 30
          ? ['codex', '--model', 'gpt-6-astra', '-c', 'model_reasoning_effort=high']
          : pid === 40 ? ['codex'] : ['bash']);
    }

    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 20, childPid: 30,
    })).toEqual({ ok: false, state: 'held', reason });
    expect(active.phase).toBe('held');
  });

  it('reads the tree once more when one read misses a live child, and still holds a persistent miss', async () => {
    const prepared = await beginCodexLaunch('ws-test', 'tab-t');
    if (!prepared.ok) throw new Error('expected prepared launch');
    installValidProcessTree(prepared.intent.generation, false);
    // The first read of the pane misses the launcher (a /proc children read racing a thread exit).
    let paneReads = 0;
    mocks.children.mockImplementation(async (pid: number) => {
      if (pid === 10) {
        paneReads += 1;
        return paneReads === 1 ? [] : [20];
      }
      return pid === 20 ? [30] : [];
    });
    await markCodexLaunchSubmitted('ws-test', 'tab-t', prepared.intent.generation);

    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation,
      launcherPid: 20, childPid: 30,
    })).toMatchObject({ ok: true, state: 'confirmed' });
    expect(paneReads).toBe(2);

    // A miss on every read is still a hold, after exactly one extra read.
    const again = await beginCodexLaunch('ws-test', 'tab-t');
    if (!again.ok) throw new Error('expected prepared launch');
    installValidProcessTree(again.intent.generation, false);
    paneReads = 0;
    mocks.children.mockImplementation(async (pid: number) => {
      if (pid === 10) {
        paneReads += 1;
        return [];
      }
      return pid === 20 ? [30] : [];
    });
    await markCodexLaunchSubmitted('ws-test', 'tab-t', again.intent.generation);

    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test', tabId: 'tab-t', generation: again.intent.generation,
      launcherPid: 20, childPid: 30,
    })).toEqual({ ok: false, state: 'held', reason: 'process-lineage-mismatch' });
    expect(paneReads).toBe(2);
  });

  it('holds wrapper-only or ambiguous process proof and never binds the resume session', async () => {
    const originalSession = mocks.tab!.agentState!.sessionId;
    const prepared = await beginCodexLaunch('ws-test', 'tab-t', { resumeSessionId: SESSION_ID });
    if (!prepared.ok) throw new Error('expected prepared launch');
    mocks.panePid.mockResolvedValue(10);
    mocks.children.mockImplementation(async (pid: number) => pid === 10 ? [20] : []);

    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test',
      tabId: 'tab-t',
      generation: prepared.intent.generation,
      launcherPid: 20,
      childPid: 30,
    })).toMatchObject({ ok: false, state: 'held' });
    expect(mocks.tab!.agentState!.sessionId).toBe(originalSession);
    expect(mocks.tab!.codexLaunchRuntime?.pending?.phase).toBe('held');
  });

  it('rejects a superseded receipt without changing the newer generation', async () => {
    const first = await beginCodexLaunch('ws-test', 'tab-t', { resumeSessionId: SESSION_ID });
    const second = await beginCodexLaunch('ws-test', 'tab-t');
    if (!first.ok || !second.ok) throw new Error('expected prepared launches');

    expect(await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test',
      tabId: 'tab-t',
      generation: first.intent.generation,
      launcherPid: 20,
      childPid: 30,
    })).toEqual({ ok: false, state: 'stale', reason: 'launch-generation-not-current' });
    expect(mocks.tab!.codexLaunchRuntime?.pending?.generation).toBe(second.intent.generation);
  });

  it('holds an overdue intent without inferring launch success', async () => {
    const prepared = await beginCodexLaunch('ws-test', 'tab-t');
    if (!prepared.ok) throw new Error('expected prepared launch');
    const preparedAt = Date.parse(mocks.tab!.codexLaunchRuntime!.pending!.preparedAt);

    expect(await reconcileCodexLaunchTimeout('ws-test', 'tab-t', preparedAt + 60_001)).toMatchObject({
      ok: true,
      state: 'held',
    });
    expect(mocks.tab!.codexLaunchRuntime?.active).toBeUndefined();
    expect(mocks.tab!.codexLaunchRuntime?.pending).toMatchObject({
      generation: prepared.intent.generation,
      phase: 'held',
      heldReason: 'launch-submission-timeout',
    });
  });

  it('persists one irreversible bootstrap claim and rejects stale hooks', async () => {
    const prepared = await beginCodexLaunch('ws-test', 'tab-t');
    if (!prepared.ok) throw new Error('expected prepared launch');
    installValidProcessTree(prepared.intent.generation, false);
    await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test',
      tabId: 'tab-t',
      generation: prepared.intent.generation,
      launcherPid: 20,
      childPid: 30,
    });

    expect(await claimCodexBootstrap('ws-test', 'tab-t')).toEqual({
      ok: true,
      generation: prepared.intent.generation,
    });
    expect(await claimCodexBootstrap('ws-test', 'tab-t')).toEqual({
      ok: false,
      reason: 'bootstrap-consumed',
    });
    mocks.tab!.agentLaunchConfig = undefined;
    mocks.tab!.agentLaunchConfig = { model: 'gpt-6-astra', effort: 'high' };
    expect(mocks.tab!.codexLaunchRuntime?.active?.bootstrap).toBe('consumed');

    expect(await validateCodexHookGeneration(mocks.tab!.sessionName, 'stale-generation')).toEqual({
      ok: false,
      reason: 'generation-not-active',
    });
    expect(await validateCodexHookGeneration(
      mocks.tab!.sessionName,
      prepared.intent.generation,
    )).toMatchObject({ ok: true, tabId: 'tab-t' });
  });

  it('a replayed hook applies on the recorded active generation with no process proof, never waits for the tab lock, and never holds (ADR-0020)', async () => {
    const prepared = await beginCodexLaunch('ws-test', 'tab-t');
    if (!prepared.ok) throw new Error('expected prepared launch');
    installValidProcessTree(prepared.intent.generation, false);
    await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test',
      tabId: 'tab-t',
      generation: prepared.intent.generation,
      launcherPid: 20,
      childPid: 30,
    });
    expect(mocks.tab!.codexLaunchRuntime!.active!.phase).toBe('active');
    // The process the spooled event came from has exited since.
    mocks.running.mockResolvedValue(false);
    vi.clearAllMocks();

    // A live hook of the same tab holds the target lock (28 Sep: each live
    // proof walked the process tree for ~10 s, and the replays queued behind them).
    let releaseLive!: () => void;
    const liveHeld = new Promise<void>((resolve) => { releaseLive = resolve; });
    const live = withCodexTargetLock('ws-test', 'tab-t', () => liveHeld);

    const work = vi.fn(() => 'applied');
    const replay = await withReplayedCodexHookGeneration(mocks.tab!.sessionName, prepared.intent.generation, work, untracked);
    expect(replay).toEqual({ ok: true, value: 'applied' });
    expect(work).toHaveBeenCalledWith({ workspaceId: 'ws-test', tabId: 'tab-t', generation: prepared.intent.generation });
    // No live condition: no tmux query, no process-tree walk, no process check.
    expect(mocks.panePid).not.toHaveBeenCalled();
    expect(mocks.children).not.toHaveBeenCalled();
    expect(mocks.running).not.toHaveBeenCalled();

    // Attribution still decides: another generation, a malformed session, no generation.
    expect(await withReplayedCodexHookGeneration(mocks.tab!.sessionName, 'stale-generation', work, untracked))
      .toEqual({ ok: false, reason: 'generation-not-active' });
    expect(await withReplayedCodexHookGeneration('pt-ws-test-pane-p-tab-other', prepared.intent.generation, work, untracked))
      .toEqual({ ok: false, reason: 'generation-not-active' });
    expect(await withReplayedCodexHookGeneration(mocks.tab!.sessionName, null, work, untracked))
      .toEqual({ ok: false, reason: 'generation-required' });
    expect(work).toHaveBeenCalledTimes(1);
    expect(mocks.tab!.codexLaunchRuntime!.active!.phase).toBe('active');

    releaseLive();
    await live;

    // The live gate still proves the process running now, and holds on a failure.
    const livePath = await withValidatedCodexHookGeneration(mocks.tab!.sessionName, prepared.intent.generation, work);
    expect(livePath.ok).toBe(false);
    expect(mocks.tab!.codexLaunchRuntime!.active!.phase).toBe('held');

    // A held generation applies no replay either.
    expect(await withReplayedCodexHookGeneration(mocks.tab!.sessionName, prepared.intent.generation, work, untracked))
      .toEqual({ ok: false, reason: 'generation-not-active' });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('a replay racing a relaunch applies nothing: the layout read still shows the old generation active, but the tracked launch is pending or newer (ADR-0020)', async () => {
    const prepared = await beginCodexLaunch('ws-test', 'tab-t');
    if (!prepared.ok) throw new Error('expected prepared launch');
    installValidProcessTree(prepared.intent.generation, false);
    await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test',
      tabId: 'tab-t',
      generation: prepared.intent.generation,
      launcherPid: 20,
      childPid: 30,
    });
    const old = prepared.intent.generation;
    // The layout read returns the tab as it was just before the relaunch wrote `pending`.
    expect(mocks.tab!.codexLaunchRuntime!.active!.generation).toBe(old);
    const work = vi.fn(() => 'applied');

    expect(await withReplayedCodexHookGeneration(mocks.tab!.sessionName, old, work,
      () => ({ generation: 'codex-relaunch', phase: 'pending' as const })))
      .toEqual({ ok: false, reason: 'launch-changed' });
    expect(await withReplayedCodexHookGeneration(mocks.tab!.sessionName, old, work,
      () => ({ generation: old, phase: 'pending' as const })))
      .toEqual({ ok: false, reason: 'launch-changed' });
    expect(await withReplayedCodexHookGeneration(mocks.tab!.sessionName, old, work,
      () => ({ generation: 'codex-relaunch', phase: 'active' as const })))
      .toEqual({ ok: false, reason: 'launch-changed' });
    expect(work).not.toHaveBeenCalled();

    // The tracked launch agrees, or none is tracked: the replay applies.
    expect(await withReplayedCodexHookGeneration(mocks.tab!.sessionName, old, work,
      (tabId) => (tabId === 'tab-t' ? { generation: old, phase: 'active' as const } : null)))
      .toEqual({ ok: true, value: 'applied' });
    expect(await withReplayedCodexHookGeneration(mocks.tab!.sessionName, old, work, untracked))
      .toEqual({ ok: true, value: 'applied' });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('a replay\'s work is synchronous by type: an async work does not type-check (ADR-0020)', () => {
    type TReplayWork = Parameters<typeof withReplayedCodexHookGeneration>[2];
    expectTypeOf<() => { applied: null }>().toExtend<TReplayWork>();
    expectTypeOf<() => string>().toExtend<TReplayWork>();
    expectTypeOf<() => Promise<{ applied: null }>>().not.toExtend<TReplayWork>();
    expectTypeOf<() => PromiseLike<string>>().not.toExtend<TReplayWork>();
  });

  it('does not claim when PATCH changed desired pins after launch', async () => {
    const prepared = await beginCodexLaunch('ws-test', 'tab-t');
    if (!prepared.ok) throw new Error('expected prepared launch');
    installValidProcessTree(prepared.intent.generation, false);
    await confirmCodexLaunchReceipt({
      workspaceId: 'ws-test',
      tabId: 'tab-t',
      generation: prepared.intent.generation,
      launcherPid: 20,
      childPid: 30,
    });
    mocks.tab!.agentLaunchConfig = { model: 'gpt-5.6-luna', effort: 'medium' };

    expect(await claimCodexBootstrap('ws-test', 'tab-t')).toEqual({
      ok: false,
      reason: 'launch-policy-changed',
    });
    expect(mocks.tab!.codexLaunchRuntime?.active?.bootstrap).toBe('unused');
  });

  it('allows a bound matching legacy hook without creating lifecycle state', async () => {
    mocks.tab!.agentState = {
      providerId: 'codex',
      sessionId: SESSION_ID,
      jsonlPath: '/sessions/current.jsonl',
      summary: null,
    };
    mocks.modelStatus.mockResolvedValue({
      expected: { model: 'gpt-6-astra', effort: 'high' },
      observed: {
        model: 'gpt-6-astra',
        effort: 'high',
        source: 'turn_context',
        timestamp: '2026-09-10T10:00:00.000Z',
        sessionId: SESSION_ID,
      },
      latestTurn: null,
      latestSettings: null,
      scanState: 'complete',
      hasActivity: true,
      status: 'match',
      reason: null,
    });
    const applied = vi.fn(() => 'applied');

    expect(await withValidatedLegacyCodexHook(mocks.tab!.sessionName, {
      sessionId: SESSION_ID,
      jsonlPath: '/sessions/current.jsonl',
    }, applied)).toEqual({ ok: true, value: 'applied' });
    expect(applied).toHaveBeenCalledOnce();
    expect(mocks.tab!.codexLaunchRuntime).toBeUndefined();

    mocks.tab!.agentState!.sessionId = null;
    expect(await withValidatedLegacyCodexHook(mocks.tab!.sessionName, {
      sessionId: SESSION_ID,
      jsonlPath: '/sessions/current.jsonl',
    }, applied)).toEqual({ ok: false, reason: 'legacy-session-binding-mismatch' });

    mocks.tab!.agentState!.sessionId = SESSION_ID;
    await beginCodexLaunch('ws-test', 'tab-t');
    expect(await withValidatedLegacyCodexHook(mocks.tab!.sessionName, {
      sessionId: SESSION_ID,
      jsonlPath: '/sessions/current.jsonl',
    }, applied)).toEqual({ ok: false, reason: 'managed-generation-present' });
  });
});
