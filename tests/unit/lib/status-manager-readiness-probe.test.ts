import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab, TPanelType } from '@/types/terminal';

// Story 17 (L8): a Claude or Grok tab whose SessionStart hook never fires stays
// `inactive` with its prompt up. After 8 s with the agent running, the poll
// looks at the pane; an empty composer is a synthetic session start. And a
// session id the poll detects is persisted, so `tab status` shows it after a
// restart.

const FIXTURES = path.join(__dirname, '../../fixtures/panes');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

const SESSION_ID = '0f6c3b1e-8a8f-4a57-9d0e-3f0f2b3c4d5e';
const OTHER_SESSION_ID = '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const state = vi.hoisted(() => ({
  tab: null as ITab | null,
  running: true,
  pane: '' as string | null,
  jsonlPath: null as string | null,
  captures: 0,
}));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: vi.fn(async () => ({ workspaces: [{ id: 'ws-1', name: 'w', directories: ['/tmp'] }] })),
  getWorkspaceByIdCached: vi.fn(async () => undefined),
  getWorkspacesCached: vi.fn(async () => ({ workspaces: [] })),
}));
vi.mock('@/lib/layout-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/layout-store')>()),
  resolveLayoutFile: () => '/nonexistent/layout.json',
  readLayoutFile: vi.fn(async () => ({ root: {} })),
  collectAllTabs: () => (state.tab ? [state.tab] : []),
  updateTabCliStatus: vi.fn(async () => {}),
  updateTabAgentSummary: vi.fn(async () => {}),
}));
vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => ({ tick: vi.fn(async () => {}), removeTab: vi.fn(), statusForTab: vi.fn(async () => ({ probes: [], backgroundJobs: [] })) }),
}));
vi.mock('@/lib/lease-sweeper', () => ({ getLeaseSweeper: () => ({ sweep: vi.fn(async () => []) }), setLeaseAgentStateSource: vi.fn() }));
vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux')>()),
  getAllPanesInfo: vi.fn(async () => new Map([['tmux-tab-a', { pid: 4242, command: 'claude', path: '/tmp' }]])),
  getChildPids: vi.fn(async () => [4243]),
  getPaneTitle: vi.fn(async () => ''),
  getSessionPanePid: vi.fn(async () => null),
  getSessionCwd: vi.fn(async () => null),
}));
vi.mock('@/lib/capture-at-width', () => ({
  capturePaneAtWidth: vi.fn(async () => {
    state.captures += 1;
    return state.pane;
  }),
}));
vi.mock('@/lib/providers/claude/session-detection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers/claude/session-detection')>()),
  isClaudeRunning: vi.fn(async () => state.running),
  detectActiveSession: vi.fn(async () => (state.jsonlPath
    ? { status: 'running', sessionId: path.basename(state.jsonlPath, '.jsonl'), jsonlPath: state.jsonlPath, pid: 4243, startedAt: null, cwd: '/tmp' }
    : { status: 'not-running', sessionId: null, jsonlPath: null, pid: null, startedAt: null, cwd: null })),
  watchSessionsDir: vi.fn(() => ({ stop: () => {} })),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));
vi.mock('@/lib/fcm-channel', () => ({ registerFcmChannel: vi.fn() }));

const T0 = new Date('2026-09-26T01:06:00Z').getTime();

const setup = async (panelType: TPanelType = 'claude-code', agentState?: ITab['agentState']) => {
  state.tab = { id: 'tab-a', name: 'a', order: 0, sessionName: 'tmux-tab-a', panelType, cliState: 'inactive', ...(agentState ? { agentState } : {}) };
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async () => state.tab),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  await import('@/lib/providers');
  const { StatusManager } = await import('@/lib/status-manager');
  const updateAgentState = vi.fn(async () => {});
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), updateAgentState);
  // As `tab create` registers a fresh agent tab.
  manager.registerTab('tab-a', {
    cliState: 'inactive', workspaceId: 'ws-1', tabName: 'a', tmuxSession: 'tmux-tab-a', panelType, lastEvent: null, eventSeq: 0,
  });
  const entry = (manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs.get('tab-a')!;
  const pollAt = async (offsetMs: number) => {
    vi.setSystemTime(T0 + offsetMs);
    await manager.poll();
  };
  return { manager, entry, pollAt, updateAgentState, paste };
};

describe('readiness pane-probe fallback (story 17)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    state.running = true;
    state.pane = fixture('claude-empty-composer.ansi');
    state.jsonlPath = null;
    state.captures = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('marks an inactive claude tab idle once its pane shows an empty composer after 8 s (W1 01:06Z)', async () => {
    const { entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(5_000);
    expect(entry.cliState).toBe('inactive');
    expect(state.captures).toBe(0);
    await pollAt(8_500);
    expect(entry.cliState).toBe('idle');
    expect(state.captures).toBe(1);
  });

  it('reads a dim prompt suggestion on the composer as an empty composer', async () => {
    state.pane = fixture('claude-dim-suggestion.ansi');
    const { entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(9_000);
    expect(entry.cliState).toBe('idle');
  });

  it('applies to grok-cli tabs as well', async () => {
    state.pane = '\n  > \n';
    const { entry, pollAt } = await setup('grok-cli');
    // grok's own process check: the default provider reads /proc, so force it through the running mock.
    const providers = await import('@/lib/providers');
    vi.spyOn(providers.getProviderByPanelType('grok-cli')!, 'isAgentRunning').mockResolvedValue(true);
    await pollAt(0);
    await pollAt(9_000);
    expect(entry.cliState).toBe('idle');
  });

  it.each([
    ['a trust prompt', 'claude-trust-prompt.ansi'],
    ['the first-run theme picker', 'claude-onboarding-theme.ansi'],
  ])('does not mark %s ready', async (_label, name) => {
    state.pane = fixture(name);
    const { entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(9_000);
    await pollAt(20_000);
    expect(entry.cliState).toBe('inactive');
    expect(state.captures).toBe(2);
  });

  it('never probes without a running agent process (a persisted idle is not proof)', async () => {
    state.running = false;
    const { entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(9_000);
    expect(entry.cliState).toBe('inactive');
    expect(state.captures).toBe(0);
  });

  it('leaves codex tabs to their own TUI detector', async () => {
    const { entry, pollAt } = await setup('codex-cli');
    await pollAt(0);
    await pollAt(9_000);
    expect(entry.cliState).toBe('inactive');
  });

  it('restarts the 8 s clock when the tab leaves inactive', async () => {
    state.pane = fixture('claude-trust-prompt.ansi');
    const { manager, entry, pollAt } = await setup();
    await pollAt(0);
    manager.updateTabFromHook('tmux-tab-a', 'session-start');
    await pollAt(4_000);
    expect(entry.cliState).toBe('idle');
    entry.cliState = 'inactive';
    state.pane = fixture('claude-empty-composer.ansi');
    await pollAt(9_000);
    expect(entry.cliState).toBe('inactive');
    await pollAt(17_500);
    expect(entry.cliState).toBe('idle');
  });
});

describe('poll-detected session id persistence (story 17)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    state.running = true;
    state.pane = fixture('claude-trust-prompt.ansi');
    state.captures = 0;
  });
  afterEach(() => vi.useRealTimers());

  const jsonl = (id: string) => `/nonexistent/projects/-tmp/${id}.jsonl`;

  it('persists a session id the poll bound when no hook bound one', async () => {
    state.jsonlPath = jsonl(SESSION_ID);
    const { entry, pollAt, updateAgentState } = await setup();
    await pollAt(0);
    expect(entry.agentSessionId).toBe(SESSION_ID);
    expect(updateAgentState).toHaveBeenCalledWith('tmux-tab-a', expect.objectContaining({ id: 'claude' }), { sessionId: SESSION_ID });
  });

  it('writes once: a layout that already holds the id is left alone', async () => {
    state.jsonlPath = jsonl(SESSION_ID);
    const { pollAt, updateAgentState } = await setup('claude-code', { providerId: 'claude', sessionId: SESSION_ID, jsonlPath: null, summary: null });
    await pollAt(0);
    await pollAt(1_000);
    expect(updateAgentState).not.toHaveBeenCalled();
  });

  it('never overwrites a binding a hook or a launch set', async () => {
    state.jsonlPath = jsonl(OTHER_SESSION_ID);
    const { pollAt, updateAgentState } = await setup('claude-code', { providerId: 'claude', sessionId: SESSION_ID, jsonlPath: null, summary: null });
    await pollAt(0);
    expect(updateAgentState).not.toHaveBeenCalled();
  });

  it('moves its own binding after a hookless /clear', async () => {
    state.jsonlPath = jsonl(SESSION_ID);
    const { pollAt, updateAgentState } = await setup();
    await pollAt(0);
    // The layout now holds what the poll wrote.
    state.tab = { ...state.tab!, agentState: { providerId: 'claude', sessionId: SESSION_ID, jsonlPath: null, summary: null } };
    state.jsonlPath = jsonl(OTHER_SESSION_ID);
    await pollAt(1_000);
    expect(updateAgentState).toHaveBeenLastCalledWith('tmux-tab-a', expect.objectContaining({ id: 'claude' }), { sessionId: OTHER_SESSION_ID });
  });

  it('hands the binding back to the hook once the hook reports one', async () => {
    state.jsonlPath = jsonl(SESSION_ID);
    const { manager, pollAt, updateAgentState } = await setup();
    await pollAt(0);
    manager.applyAgentHookMeta('claude', 'tmux-tab-a', { sessionId: SESSION_ID });
    state.tab = { ...state.tab!, agentState: { providerId: 'claude', sessionId: SESSION_ID, jsonlPath: null, summary: null } };
    updateAgentState.mockClear();
    state.jsonlPath = jsonl(OTHER_SESSION_ID);
    await pollAt(1_000);
    expect(updateAgentState).not.toHaveBeenCalledWith('tmux-tab-a', expect.anything(), { sessionId: OTHER_SESSION_ID });
  });
});
