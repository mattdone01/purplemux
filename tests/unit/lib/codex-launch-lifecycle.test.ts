import { beforeEach, describe, expect, it, vi } from 'vitest';
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
}));

vi.mock('@/lib/cli-utils', () => ({ findTab: mocks.findTab }));
vi.mock('@/lib/layout-store', () => ({
  mutateTabAtomically: vi.fn(async (
    _workspaceId: string,
    tabId: string,
    mutator: (tab: ITab) => { changed: boolean; value: unknown },
  ) => {
    if (!mocks.tab || mocks.tab.id !== tabId) return { found: false };
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
