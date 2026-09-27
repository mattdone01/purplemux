import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { IHookDelivery } from '@/lib/hook-dispatch';
import type { StatusManager } from '@/lib/status-manager';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// ADR-0020: the server replays what hooks spooled while no server answered —
// at boot before the first poll and on every poll, oldest first, through the
// hook route's own dispatcher, with each event's original time.

const state = vi.hoisted(() => ({ tabs: [] as ITab[], home: '' }));
const layoutWrites = vi.hoisted(() => ({ updateTabHookFloor: vi.fn(async (_session: string, _at: number) => {}) }));
const WS = { id: 'ws-1', name: 'w', directories: ['/tmp'], orchestration: { enabled: true, orchestratorTabId: 'root' } };

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => state.home }, homedir: () => state.home };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: vi.fn(async () => ({ workspaces: [WS] })),
  getWorkspaceByIdCached: vi.fn(async () => WS),
  getWorkspacesCached: vi.fn(async () => ({ workspaces: [WS] })),
}));
vi.mock('@/lib/layout-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/layout-store')>()),
  resolveLayoutFile: () => '/nonexistent/layout.json',
  readLayoutFile: vi.fn(async () => ({ root: {} })),
  collectAllTabs: () => state.tabs,
  updateTabCliStatus: vi.fn(async () => {}),
  updateTabAgentSummary: vi.fn(async () => {}),
  updateTabAgentState: vi.fn(async () => {}),
  updateTabWatchdogTurnEnd: vi.fn(async () => {}),
  updateTabHookFloor: layoutWrites.updateTabHookFloor,
}));
vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => ({
    tick: vi.fn(async () => {}),
    removeTab: vi.fn(),
    statusForTab: vi.fn(async () => ({ probes: [], backgroundJobs: [] })),
    reconcileJobs: vi.fn(async () => ({ reported: 0, pendingDead: 0 })),
  }),
}));
vi.mock('@/lib/lease-sweeper', () => ({ getLeaseSweeper: () => ({ sweep: vi.fn(async () => []) }), setLeaseAgentStateSource: vi.fn() }));
vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux')>()),
  getAllPanesInfo: vi.fn(async () => new Map([['tmux-w', { pid: 4242, command: 'claude', path: '/tmp' }]])),
  getChildPids: vi.fn(async () => [4243]),
  getPaneTitle: vi.fn(async () => ''),
  getSessionPanePid: vi.fn(async () => null),
  getSessionCwd: vi.fn(async () => null),
  capturePaneContent: vi.fn(async () => null),
}));
vi.mock('@/lib/providers/claude/session-detection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers/claude/session-detection')>()),
  isClaudeRunning: vi.fn(async () => true),
  detectActiveSession: vi.fn(async () => ({ status: 'not-running', sessionId: null, jsonlPath: null, pid: null, startedAt: null, cwd: null })),
  watchSessionsDir: vi.fn(() => ({ stop: () => {} })),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));
vi.mock('@/lib/fcm-channel', () => ({ registerFcmChannel: vi.fn() }));
vi.mock('@/lib/claude-usage-poller', () => ({ createClaudeUsagePoller: () => ({ start: () => {}, stop: () => {} }) }));
vi.mock('@/lib/rate-limits-watcher', () => ({ createRateLimitsWatcher: () => ({ start: () => {}, stop: () => {} }) }));

const g = globalThis as unknown as { __ptStatusManager?: StatusManager };

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

const spoolDir = () => path.join(state.home, '.purplemux', 'hook-spool');

let serial = 0;
/** One file as `spool_hook` writes it: `<at>-<pid>-<rand>.json`. */
const spoolEvent = async (at: number, body: unknown, query = '', session = 'tmux-w'): Promise<string> => {
  await fs.mkdir(spoolDir(), { recursive: true });
  serial += 1;
  const name = `${at}-${1000 + serial}-${serial.toString(16).padStart(8, '0')}.json`;
  await fs.writeFile(path.join(spoolDir(), name), `${JSON.stringify({ v: 1, at, session, query, body })}\n`);
  return name;
};

const claudeStop = (session = 'tmux-w') => ({ event: 'stop', session });
const claudePrompt = (session = 'tmux-w') => ({ event: 'prompt-submit', session });

const managerWithPaste = async () => {
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  await import('@/lib/providers');
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}));
  // The route's dispatcher reaches the manager through the singleton.
  g.__ptStatusManager = manager;
  const { dispatchHook } = await import('@/lib/hook-dispatch');
  const { drainHookSpool } = await import('@/lib/hook-spool');
  const applied: IHookDelivery[] = [];
  manager.setHookSpoolDrain(() => drainHookSpool(async (delivery) => {
    applied.push(delivery);
    return dispatchHook(delivery);
  }, { dir: spoolDir() }));
  return { manager, paste, applied };
};

const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 5000 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-hook-spool-drain-'));
  state.tabs = [];
});

afterEach(async () => {
  g.__ptStatusManager?.shutdown();
  delete g.__ptStatusManager;
  vi.useRealTimers();
  await fs.rm(state.home, { recursive: true, force: true });
});

const internalsOf = (manager: StatusManager) => manager as unknown as { tabs: Map<string, ITabStatusEntry> };

const writeDoneTranscript = async (): Promise<string> => {
  const transcript = path.join(state.home, 'claude', 's.jsonl');
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-27T15:00:00.000Z',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Story shipped.\n\nDONE: story 41 merged' }] },
  })}\n`);
  return transcript;
};

describe('the status manager replays the hook spool (ADR-0020)', () => {
  it('init does not drain; the boot drains after listen replay in time order, each event at its own time, and a late drain catches a late file', async () => {
    state.tabs = [tab('w')];
    const { manager, applied } = await managerWithPaste();
    const t0 = Date.now() - 60_000;
    // Written stop first: the drain orders by the event time, not by the order files appeared.
    await spoolEvent(t0 + 2_000, claudeStop());
    await spoolEvent(t0 + 1_000, claudePrompt());
    const startPolling = vi.spyOn(manager, 'startPolling');

    await manager.init();
    expect(startPolling).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([]);
    expect(await fs.readdir(spoolDir())).toHaveLength(2);

    manager.startBootHookSpoolDrains(100);
    await waitFor(() => expect(applied).toHaveLength(2));
    expect(applied.map((d) => [(d.body as { event: string }).event, d.replayedAt])).toEqual([
      ['prompt-submit', t0 + 1_000],
      ['stop', t0 + 2_000],
    ]);
    const entry = internalsOf(manager).tabs.get('w')!;
    expect(entry.lastEvent).toMatchObject({ name: 'stop', at: t0 + 2_000 });
    await waitFor(() => expect(entry.turnEnd).toMatchObject({ kind: 'ready-for-review', at: t0 + 2_000 }));
    expect(manager.getHookHistory('w')).toEqual([
      { event: 'prompt-submit', at: t0 + 1_000, replayed: true, stale: false },
      { event: 'stop', at: t0 + 2_000, replayed: true, stale: false },
    ]);

    // A hook that saw no port file renames its file after the first drain listed the spool.
    await spoolEvent(t0 + 3_000, claudePrompt());
    await waitFor(() => expect(applied).toHaveLength(3));
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('drains on every poll', async () => {
    const { manager, applied } = await managerWithPaste();
    manager.registerTab('w', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code' });
    state.tabs = [tab('w')];
    await spoolEvent(Date.now() - 5_000, claudePrompt());
    await manager.poll();
    expect(applied).toHaveLength(1);
    await spoolEvent(Date.now() - 1_000, claudeStop());
    await manager.poll();
    expect(applied).toHaveLength(2);
  });

  it('an event older than the tab\'s floor updates history only, never the newer state', async () => {
    const { manager } = await managerWithPaste();
    const entry: ITabStatusEntry = {
      cliState: 'busy', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code',
      agentProviderId: 'claude', jsonlPath: null, lastEvent: { name: 'prompt-submit', at: Date.now() - 60_000, seq: 1 }, eventSeq: 1,
    };
    manager.registerTab('w', entry);
    manager.updateTabFromHook('tmux-w', 'stop');
    await waitFor(() => expect(entry.cliState).toBe('ready-for-review'));
    const liveStop = entry.lastEvent!;
    const olderPrompt = liveStop.at - 10_000;
    await spoolEvent(olderPrompt, claudePrompt());

    await manager.drainHookSpool();

    expect(entry.cliState).toBe('ready-for-review');
    expect(entry.lastEvent).toEqual(liveStop);
    expect(manager.getHookHistory('w')).toEqual([
      { event: 'prompt-submit', at: olderPrompt, replayed: true, stale: true },
      { event: 'stop', at: liveStop.at, replayed: false, stale: false },
    ]);
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('a floor persisted by a previous server orders replays after a restart: an older DONE stop is history only, a newer one nudges once', async () => {
    const floor = Date.now() - 60_000;
    state.tabs = [tab('root'), { ...tab('w'), hookFloorAt: floor }];
    const { manager, paste, applied } = await managerWithPaste();
    await manager.init();
    const entry = internalsOf(manager).tabs.get('w')!;
    // The tab is mid-turn on a transcript whose last message carries an end line.
    entry.cliState = 'busy';
    entry.agentProviderId = 'claude';
    entry.jsonlPath = await writeDoneTranscript();

    await spoolEvent(floor - 5_000, claudeStop());
    await manager.drainHookSpool();
    await settle();
    expect(applied).toHaveLength(1);
    expect(paste).not.toHaveBeenCalled();
    expect(entry.cliState).toBe('busy');
    expect(manager.getHookHistory('w')).toEqual([{ event: 'stop', at: floor - 5_000, replayed: true, stale: true }]);

    // Control: the same transcript does nudge for a stop newer than the floor, and only once.
    await spoolEvent(floor + 5_000, claudeStop());
    await spoolEvent(floor + 5_000, claudeStop());
    await manager.drainHookSpool();
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
    await settle();
    expect(paste).toHaveBeenCalledTimes(1);
    expect(paste).toHaveBeenCalledWith('tmux-root', expect.stringContaining('DONE: story 41 merged'));
  });

  it('persists the floor, raised by state events and by metadata patches, coalesced per tab', async () => {
    const { manager } = await managerWithPaste();
    manager.registerTab('w', {
      cliState: 'idle', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code',
      agentProviderId: 'claude', lastEvent: null, eventSeq: 0,
    });
    manager.updateTabFromHook('tmux-w', 'prompt-submit');
    const promptAt = manager.getHookHistory('w')[0].at;
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A live metadata patch is an applied event: it raises the floor past the prompt.
    manager.applyAgentHookMeta('claude', 'tmux-w', { lastUserMessage: 'newer' });
    expect(manager.applyAgentHookMeta('claude', 'tmux-w', { lastUserMessage: 'older' }, promptAt + 1))
      .toMatchObject({ stale: true });
    expect(internalsOf(manager).tabs.get('w')!.lastUserMessage).toBe('newer');
    expect(layoutWrites.updateTabHookFloor).not.toHaveBeenCalled();

    manager.shutdown();
    expect(layoutWrites.updateTabHookFloor).toHaveBeenCalledTimes(1);
    const [session, at] = layoutWrites.updateTabHookFloor.mock.calls[0];
    expect(session).toBe('tmux-w');
    expect(at).toBeGreaterThan(promptAt);
  });

  it('a stale replayed hook meta patch changes nothing and says stale', async () => {
    const { manager } = await managerWithPaste();
    manager.registerTab('w', {
      cliState: 'busy', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code',
      agentProviderId: 'claude', lastUserMessage: 'newer', lastEvent: null, eventSeq: 0,
    });
    manager.updateTabFromHook('tmux-w', 'prompt-submit');
    const latest = manager.getHookHistory('w')[0].at;
    expect(manager.applyAgentHookMeta('claude', 'tmux-w', { lastUserMessage: 'older' }, latest - 1))
      .toEqual({ tabId: 'w', cliState: 'busy', stale: true });
    expect(internalsOf(manager).tabs.get('w')!.lastUserMessage).toBe('newer');
  });

  it('a replayed stop is classified as it would have been, and nudges once, however often the spool is drained', async () => {
    const { manager, paste } = await managerWithPaste();
    manager.registerTab('root', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'root', tmuxSession: 'tmux-root', panelType: 'claude-code' });
    const entry: ITabStatusEntry = {
      cliState: 'busy', workspaceId: 'ws-1', tabName: 'w1', tmuxSession: 'tmux-w', panelType: 'claude-code',
      agentProviderId: 'claude', jsonlPath: await writeDoneTranscript(), lastEvent: { name: 'prompt-submit', at: Date.now() - 120_000, seq: 1 }, eventSeq: 1,
    };
    manager.registerTab('w', entry);
    const stopAt = Date.now() - 30_000;
    await spoolEvent(stopAt, claudeStop());

    await Promise.all([manager.drainHookSpool(), manager.drainHookSpool()]);
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
    await manager.drainHookSpool();
    await settle();

    expect(paste).toHaveBeenCalledTimes(1);
    expect(paste).toHaveBeenCalledWith('tmux-root', expect.stringContaining('DONE: story 41 merged'));
    expect(entry.turnEnd).toMatchObject({ kind: 'turn-marker', at: stopAt, marker: ['DONE: story 41 merged'] });
  });

  it('replays a spooled Claude tool event into the signal engine', async () => {
    const { manager } = await managerWithPaste();
    manager.registerTab('w', { cliState: 'busy', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code' });
    const tool = vi.spyOn(manager, 'handleToolActivity');
    await spoolEvent(Date.now() - 1_000, { tool_name: 'Edit', tool_input: { file_path: '/tmp/a.ts' } }, 'kind=tool&session=tmux-w');
    await manager.drainHookSpool();
    expect(tool).toHaveBeenCalledWith('claude', 'tmux-w', expect.objectContaining({ tool: 'Edit' }), expect.any(Number));
  });

  it('a file past the replay window is dropped without dispatch; a direct replay that old changes no state and feeds no signal', async () => {
    const { manager, applied } = await managerWithPaste();
    const { HOOK_REPLAY_WINDOW_MS } = await import('@/lib/hook-spool');
    const entry: ITabStatusEntry = { cliState: 'idle', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code', lastEvent: null, eventSeq: 0 };
    manager.registerTab('w', entry);
    const old = Date.now() - HOOK_REPLAY_WINDOW_MS - 60_000;
    await spoolEvent(old, claudePrompt());

    await manager.drainHookSpool();
    expect(applied).toEqual([]);
    expect(await fs.readdir(spoolDir())).toEqual([]);

    const { getSignalEngine } = await import('@/lib/signal-engine');
    const record = vi.spyOn(getSignalEngine(), 'record');
    manager.handleProviderEvent('claude', 'tmux-w', { kind: 'prompt-submit' }, old);
    manager.handleToolActivity('claude', 'tmux-w', { tool: 'Edit', paths: ['/tmp/a.ts'], failed: false } as never, old);
    expect(entry.cliState).toBe('idle');
    expect(entry.lastEvent).toBeNull();
    expect(manager.getHookHistory('w')).toEqual([{ event: 'prompt-submit', at: old, replayed: true, stale: true }]);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('drainHookSpool (ADR-0020)', () => {
  const drain = async (apply: (d: IHookDelivery) => Promise<unknown>, options: { now?: number; maxFiles?: number; maxAgeMs?: number } = {}) => {
    const { drainHookSpool } = await import('@/lib/hook-spool');
    return drainHookSpool(apply, { dir: spoolDir(), ...options });
  };
  const collect = () => {
    const seen: IHookDelivery[] = [];
    return { seen, apply: async (d: IHookDelivery) => { seen.push(d); } };
  };
  const age = async (file: string, ms: number) => {
    const when = new Date(Date.now() - ms);
    await fs.utimes(file, when, when);
  };
  const MIN = 60_000;

  it('parses the query, passes the body as written, and deletes each applied file', async () => {
    const { seen, apply } = collect();
    const now = Date.now();
    await spoolEvent(now - 1_000, { hook_event_name: 'Stop' }, 'provider=codex&tmuxSession=pt-a&generation=g1');
    expect(await drain(apply, { now })).toMatchObject({ applied: 1, bad: 0, dropped: 0 });
    expect(seen).toEqual([{ query: { provider: 'codex', tmuxSession: 'pt-a', generation: 'g1' }, body: { hook_event_name: 'Stop' }, replayedAt: now - 1_000 }]);
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('moves a file that fails to parse to bad/, and still applies the rest', async () => {
    const { seen, apply } = collect();
    const now = Date.now();
    await fs.mkdir(spoolDir(), { recursive: true });
    await fs.writeFile(path.join(spoolDir(), `${now - 1_500}-1-aa.json`), '{"v":1,"at":1500,"session":"pt-a","query":"","body":{"event":"st');
    await fs.writeFile(path.join(spoolDir(), 'stray.txt'), 'not a spool file');
    await spoolEvent(now - 2_000, claudePrompt());
    await spoolEvent(now - 1_000, claudeStop());
    expect(await drain(apply, { now })).toMatchObject({ applied: 2, bad: 2, dropped: 0 });
    expect(seen.map((d) => d.replayedAt)).toEqual([now - 2_000, now - 1_000]);
    expect((await fs.readdir(path.join(spoolDir(), 'bad'))).sort()).toEqual([`${now - 1_500}-1-aa.json`, 'stray.txt']);
    expect((await fs.readdir(spoolDir())).filter((n) => n !== 'bad')).toEqual([]);
  });

  it('moves a file whose replay throws (a 5xx event) to bad/ once, and never retries it', async () => {
    const now = Date.now();
    await spoolEvent(now - 1_000, claudeStop());
    const apply = vi.fn(async () => { throw new Error('boom'); });
    expect(await drain(apply, { now })).toMatchObject({ applied: 0, bad: 1 });
    expect(await drain(apply, { now })).toMatchObject({ applied: 0, bad: 0 });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(path.join(spoolDir(), 'bad'))).toHaveLength(1);
  });

  it('drops a file past the replay window without dispatching it', async () => {
    const { HOOK_REPLAY_WINDOW_MS } = await import('@/lib/hook-spool');
    const { seen, apply } = collect();
    const now = Date.now();
    await spoolEvent(now - HOOK_REPLAY_WINDOW_MS - 1, claudeStop());
    await spoolEvent(now - HOOK_REPLAY_WINDOW_MS + 1_000, claudePrompt());
    expect(await drain(apply, { now })).toMatchObject({ applied: 1, dropped: 1 });
    expect(seen.map((d) => d.replayedAt)).toEqual([now - HOOK_REPLAY_WINDOW_MS + 1_000]);
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('bounds the spool: drops the oldest beyond the file limit, unreplayed', async () => {
    const { seen, apply } = collect();
    for (const at of [100, 5_000, 6_000, 7_000, 8_000, 9_000]) await spoolEvent(at, claudeStop());
    expect(await drain(apply, { now: 10_000, maxAgeMs: 6_000, maxFiles: 3 })).toMatchObject({ applied: 3, dropped: 3 });
    expect(seen.map((d) => d.replayedAt)).toEqual([7_000, 8_000, 9_000]);
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('a file whose body the hook dropped for size is deleted and never dispatched', async () => {
    const { seen, apply } = collect();
    const now = Date.now();
    await fs.mkdir(spoolDir(), { recursive: true });
    await fs.writeFile(path.join(spoolDir(), `${now - 1_000}-1-bb.json`),
      JSON.stringify({ v: 1, at: now - 1_000, session: 'pt-a', query: 'kind=tool&session=pt-a', bodyDropped: true, bodyLength: 300_000, body: null }));
    expect(await drain(apply, { now })).toMatchObject({ applied: 0, metadataOnly: 1, bad: 0 });
    expect(seen).toEqual([]);
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('prunes bad/ entries older than 7 days and orphaned temporaries older than 10 minutes; keeps younger ones', async () => {
    const { apply } = collect();
    const bad = path.join(spoolDir(), 'bad');
    await fs.mkdir(path.join(bad, 'rollback-20260901T000000Z'), { recursive: true });
    await fs.writeFile(path.join(bad, 'rollback-20260901T000000Z', '1-1-aa.json'), '{}');
    await fs.writeFile(path.join(bad, 'old.json'), '{}');
    await fs.writeFile(path.join(bad, 'young.json'), '{}');
    await fs.writeFile(path.join(spoolDir(), '.1-1-old.json.tmp'), '{"v":1,');
    await fs.writeFile(path.join(spoolDir(), '.2-1-young.json.tmp'), '{"v":1,');
    await age(path.join(bad, 'rollback-20260901T000000Z'), 8 * 24 * 60 * MIN);
    await age(path.join(bad, 'old.json'), 8 * 24 * 60 * MIN);
    await age(path.join(spoolDir(), '.1-1-old.json.tmp'), 11 * MIN);

    expect(await drain(apply)).toMatchObject({ prunedBad: 2, prunedTmp: 1 });
    expect(await fs.readdir(bad)).toEqual(['young.json']);
    expect((await fs.readdir(spoolDir())).sort()).toEqual(['.2-1-young.json.tmp', 'bad']);
  });

  it('dates no event after now', async () => {
    const { seen, apply } = collect();
    const now = Date.now();
    await spoolEvent(now + 9_000, claudeStop());
    await drain(apply, { now });
    expect(seen.map((d) => d.replayedAt)).toEqual([now]);
  });

  it('the health route answers while a large spool drains', async () => {
    const now = Date.now();
    await fs.mkdir(spoolDir(), { recursive: true });
    await Promise.all(Array.from({ length: 400 }, (_, i) => fs.writeFile(
      path.join(spoolDir(), `${now - 10_000 + i}-1-${i.toString(16).padStart(8, '0')}.json`),
      JSON.stringify({ v: 1, at: now - 10_000 + i, session: 'pt-a', query: '', body: claudePrompt() }),
    )));
    let applied = 0;
    let done = false;
    const draining = drain(async () => { applied += 1; }, { now }).then(() => { done = true; });
    await new Promise((resolve) => setImmediate(resolve));

    const { default: health } = await import('@/pages/api/health');
    const answer = await new Promise((resolve) => {
      health({} as never, { json: resolve } as never);
    });
    expect(answer).toMatchObject({ app: 'purplemux' });
    expect(done).toBe(false);
    await draining;
    expect(applied).toBe(400);
  });

  it('an absent spool directory is an empty spool', async () => {
    const { seen, apply } = collect();
    expect(await drain(apply)).toEqual({ applied: 0, bad: 0, dropped: 0, metadataOnly: 0, prunedBad: 0, prunedTmp: 0 });
    expect(seen).toEqual([]);
  });
});

describe('server boot wiring (ADR-0020)', () => {
  it('sets the drain before the status manager starts, and starts the boot drains, unawaited, once the server listens and the port file exists', async () => {
    const server = await fs.readFile(path.join(__dirname, '..', '..', '..', 'server.ts'), 'utf-8');
    const wire = server.indexOf('getStatusManager().setHookSpoolDrain(() => drainHookSpool(dispatchHook));');
    const init = server.indexOf('await getStatusManager().init();');
    const listen = server.indexOf('? await startDev(port, appDir, bindPlan.host)');
    const portFile = server.indexOf('await ensureHookSettings(result.port);');
    const boot = server.indexOf('  getStatusManager().startBootHookSpoolDrains();');
    expect(wire).toBeGreaterThan(0);
    expect(wire).toBeLessThan(init);
    expect(listen).toBeGreaterThan(init);
    expect(portFile).toBeGreaterThan(listen);
    expect(boot).toBeGreaterThan(portFile);
    expect(server).not.toContain('await getStatusManager().drainHookSpool()');
    expect(server).not.toContain('await getStatusManager().startBootHookSpoolDrains()');
  });
});
