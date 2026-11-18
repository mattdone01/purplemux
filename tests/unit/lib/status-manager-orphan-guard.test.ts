import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { IOrphanSuspect } from '@/lib/tab-orphans';
import type { IOrphanHostEntries } from '@/lib/tab-orphans-service';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';
import { memoryLedgerTables, memoryTabEvents } from './tab-events-harness';

// The orphan liveness guard: a tab whose agent left its pane answers `unknown`, not `inactive`, only for an unmarked
// agent that shares its cwd, started after its last launch, and that no other live pane holds. Otherwise `inactive`
// as before. And the hourly list: one line to the orchestrator, no kill.

const state = vi.hoisted(() => ({
  tabs: [] as ITab[],
  home: '',
  suspects: [] as IOrphanSuspect[] | null,
  scans: 0,
  sweep: [] as IOrphanHostEntries[],
}));
const WS = { id: 'ws-test1', name: 'w', directories: ['/tmp'], orchestration: { enabled: true, orchestratorTabId: 'root' } };

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
  updateTabAgentSummary: vi.fn(async () => {}),
  updateTabWatchdogTurnEnd: vi.fn(async () => {}),
  updateTabOrphanHold: vi.fn(async (session: string, hold: ITab['orphanHold'] | null) => {
    const tab = state.tabs.find((t) => t.sessionName === session);
    if (!tab) return;
    if (hold) tab.orphanHold = hold;
    else delete tab.orphanHold;
  }),
  updateTabCliStatus: vi.fn(async (session: string, cliState: ITab['cliState']) => {
    const tab = state.tabs.find((t) => t.sessionName === session);
    if (tab) tab.cliState = cliState;
  }),
}));
vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => ({
    tick: vi.fn(async () => {}),
    removeTab: vi.fn(),
    statusForTab: vi.fn(async () => ({ probes: [], backgroundJobs: [] })),
    reconcileJobs: vi.fn(async () => ({ reported: 0, pendingDead: 0 })),
    takeJobs: vi.fn(async () => []),
  }),
}));
vi.mock('@/lib/lease-sweeper', () => ({ getLeaseSweeper: () => ({ sweep: vi.fn(async () => []) }), setLeaseAgentStateSource: vi.fn() }));
vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux')>()),
  getAllPanesInfo: vi.fn(async () => new Map([
    ['tmux-w', { pid: 4242, command: 'bash', path: '/work/shared' }],
    ['tmux-v', { pid: 4343, command: 'bash', path: '/work/shared' }],
    ['tmux-root', { pid: 4444, command: 'claude', path: '/work/root' }],
  ])),
  getChildPids: vi.fn(async () => []),
  getPaneTitle: vi.fn(async () => ''),
  getSessionPanePid: vi.fn(async () => null),
  getSessionCwd: vi.fn(async () => null),
  capturePaneContent: vi.fn(async () => null),
}));
vi.mock('@/lib/providers/claude/session-detection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers/claude/session-detection')>()),
  isClaudeRunning: vi.fn(async () => false),
  detectActiveSession: vi.fn(async () => ({ status: 'not-running', sessionId: null, jsonlPath: null, pid: null, startedAt: null, cwd: null })),
  watchSessionsDir: vi.fn(() => ({ stop: () => {} })),
}));
vi.mock('@/lib/tab-orphans-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tab-orphans-service')>()),
  findOrphanSuspects: vi.fn(async () => {
    state.scans += 1;
    return state.suspects;
  }),
  listOrphanEntries: vi.fn(async () => state.sweep),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));
vi.mock('@/lib/fcm-channel', () => ({ registerFcmChannel: vi.fn() }));

await Promise.all([import('@/lib/providers'), import('@/lib/status-manager')]);

const MIN = 60_000;
const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

const setup = async (workers: Record<string, number>) => {
  state.tabs = Object.keys(workers).map(tab);
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste: vi.fn(async () => {}),
  });
  await import('@/lib/providers');
  const { StatusManager } = await import('@/lib/status-manager');
  const tabEvents = memoryTabEvents();
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}), tabEvents, memoryLedgerTables()[1]);
  (manager as unknown as { dispatchAlert: () => Promise<void> }).dispatchAlert = vi.fn(async () => {});
  manager.registerTab('root', { cliState: 'idle', workspaceId: 'ws-test1', tabName: 'root', tmuxSession: 'tmux-root', panelType: 'claude-code' });
  const entries: Record<string, ITabStatusEntry> = {};
  for (const [id, launchedAt] of Object.entries(workers)) {
    entries[id] = {
      cliState: 'idle', workspaceId: 'ws-test1', tabName: id, tmuxSession: `tmux-${id}`, panelType: 'claude-code',
      agentProviderId: 'claude', jsonlPath: null, lastEvent: { name: 'stop', at: launchedAt, seq: 1 }, eventSeq: 1, paneTitle: '',
      lastResumeOrStartedAt: launchedAt,
    };
    manager.registerTab(id, entries[id]);
  }
  const sent = () => tabEvents().list('ws-test1', { since: 0, limit: 100 })
    .filter((row) => row.class !== 'log').map((row) => ({ to: row.tabId, kind: row.kind, message: row.text }));
  return { manager, entries, sent };
};

const orphan = (startedAt: number, cwd = '/work/shared'): IOrphanSuspect => ({ pid: 4747, comm: 'claude', cwd, startedAt, heldBy: null });

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.suspects = [];
  state.scans = 0;
  state.sweep = [];
  state.home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-orphan-guard-'));
});

afterEach(async () => {
  await fs.rm(state.home, { recursive: true, force: true });
});

describe('the orphan liveness guard', () => {
  it('with no suspect the answer is absent: the tab turns inactive and its orchestrator hears INACTIVE', async () => {
    const now = Date.now();
    const { manager, entries, sent } = await setup({ w: now - 10 * MIN });
    await manager.poll();
    expect(entries.w.cliState).toBe('inactive');
    expect(state.scans).toBe(1);
    await vi.waitFor(() => expect(sent().map((s) => s.kind)).toEqual(['inactive']));
  });

  it('an unmarked agent in the tab\'s cwd, started after its launch: unknown, not inactive, and one line naming the pid and the tab', async () => {
    const now = Date.now();
    state.suspects = [orphan(now - 2 * MIN)];
    const { manager, entries, sent } = await setup({ w: now - 10 * MIN });
    await manager.poll();
    expect(entries.w.cliState).toBe('unknown');
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({ to: 'root', kind: 'orphan-suspect' });
    expect(sent()[0].message).toContain('pid 4747');
    expect(sent()[0].message).toContain('worker w');
    expect(sent()[0].message).not.toContain('INACTIVE');
  });

  it('an orphan older than the tab\'s launch makes nothing unknown', async () => {
    const now = Date.now();
    state.suspects = [orphan(now - 20 * MIN)];
    const { manager, entries } = await setup({ w: now - 10 * MIN });
    await manager.poll();
    expect(entries.w.cliState).toBe('inactive');
  });

  it('two tabs share a cwd: one orphan makes at most the matching tab unknown', async () => {
    const now = Date.now();
    state.suspects = [orphan(now - 2 * MIN)];
    const first = await setup({ w: now - 10 * MIN, v: now - 5 * MIN });
    await first.manager.poll();
    expect(first.entries.v.cliState).toBe('unknown');
    expect(first.entries.w.cliState).toBe('inactive');
    expect(state.scans).toBe(1);

    state.suspects = [orphan(now - 7 * MIN)];
    const second = await setup({ w: now - 10 * MIN, v: now - 5 * MIN });
    await second.manager.poll();
    expect(second.entries.w.cliState).toBe('unknown');
    expect(second.entries.v.cliState).toBe('inactive');
  });

  it('an orphan in another cwd, or a host that cannot be scanned, leaves the answer absent', async () => {
    const now = Date.now();
    state.suspects = [orphan(now - 2 * MIN, '/work/elsewhere')];
    const other = await setup({ w: now - 10 * MIN });
    await other.manager.poll();
    expect(other.entries.w.cliState).toBe('inactive');
    state.suspects = null;
    const unread = await setup({ w: now - 10 * MIN });
    await unread.manager.poll();
    expect(unread.entries.w.cliState).toBe('inactive');
  });

  it('the hold stays while the suspect lives and nothing restarts the tab; once it is gone the tab is judged again', async () => {
    const now = Date.now();
    state.suspects = [orphan(now - 2 * MIN)];
    const { manager, entries, sent } = await setup({ w: now - 10 * MIN });
    await manager.poll();
    await manager.poll();
    expect(entries.w.cliState).toBe('unknown');
    await vi.waitFor(() => expect(sent().map((s) => s.kind)).toEqual(['orphan-suspect']));
    state.suspects = [];
    await manager.poll();
    expect(entries.w.cliState).toBe('inactive');
    await vi.waitFor(() => expect(sent().map((s) => s.kind)).toEqual(['orphan-suspect', 'inactive']));
  });
});

describe('the orphan hold across a server restart', () => {
  it('the layout keeps the hold: after a restart the tab stays unknown, is never read idle, and is judged once the suspect is gone', async () => {
    const now = Date.now();
    state.suspects = [orphan(now - 2 * MIN)];
    const first = await setup({ w: now - 10 * MIN });
    await first.manager.poll();
    expect(first.entries.w.cliState).toBe('unknown');
    const persisted = state.tabs.find((t) => t.id === 'w')!;
    await vi.waitFor(() => expect(persisted.orphanHold).toEqual({ pid: 4747, prevState: 'idle', launchedAt: now - 10 * MIN }));
    expect(persisted.cliState).toBe('unknown');

    // A new server reads the same layout: the launch stamp lived only in the old one's memory.
    vi.resetModules();
    const { StatusManager } = await import('@/lib/status-manager');
    const tabEvents = memoryTabEvents();
    const restarted = new StatusManager(undefined, vi.fn(async () => true), vi.fn(async () => {}), tabEvents, memoryLedgerTables()[1]);
    (restarted as unknown as { dispatchAlert: () => Promise<void> }).dispatchAlert = vi.fn(async () => {});
    const internals = restarted as unknown as { scanAllTabs: () => Promise<void>; tabs: Map<string, ITabStatusEntry> };
    await internals.scanAllTabs();
    const entry = internals.tabs.get('w')!;
    expect(entry.cliState).toBe('unknown');
    expect(entry.lastResumeOrStartedAt).toBe(now - 10 * MIN);
    await new Promise((r) => setTimeout(r, 20));
    expect(entry.cliState).toBe('unknown');
    await restarted.poll();
    expect(internals.tabs.get('w')!.cliState).toBe('unknown');

    state.suspects = [];
    await restarted.poll();
    expect(internals.tabs.get('w')!.cliState).toBe('inactive');
    await vi.waitFor(() => expect(persisted.orphanHold).toBeUndefined());
  });

  it('without a persisted hold the same restart reads the tab as before (the hold is what keeps it unknown)', async () => {
    state.tabs = [{ ...tab('w'), cliState: 'unknown' }];
    const { StatusManager } = await import('@/lib/status-manager');
    const restarted = new StatusManager(undefined, vi.fn(async () => true), vi.fn(async () => {}), memoryTabEvents(), memoryLedgerTables()[1]);
    const internals = restarted as unknown as { scanAllTabs: () => Promise<void>; tabs: Map<string, ITabStatusEntry> };
    await internals.scanAllTabs();
    await vi.waitFor(() => expect(internals.tabs.get('w')!.cliState).not.toBe('unknown'));
  });
});

describe('the hourly orphan list', () => {
  const internals = (manager: unknown) => manager as { runOrphanSweep: (now: number) => Promise<void>; orphanSweepDueAt: number };
  const fact = (pid: number, tabId: string | null) => ({
    pid, ppid: 1, comm: 'claude', ageMs: 10 * MIN, cwd: '/work/shared', start: '1', tabId, urlMatch: true, socketMatch: false, underServer: false, heldBy: null, heldKnown: true, agentAbove: false, agent: true,
  });

  it('a non-empty list sends the orchestrator one line, names its own and unattributed entries, and kills nothing', async () => {
    const { manager, sent } = await setup({ w: Date.now() - 10 * MIN });
    state.sweep = [
      { host: 'local', status: 'ok', entries: [
        { kind: 'duplicate-agent', process: fact(501, 'tab-aaaa'), workspaceId: 'ws-test1' },
        { kind: 'duplicate-agent', process: fact(502, 'tab-bbbb'), workspaceId: 'ws-test2' },
        { kind: 'unmarked-agent', process: fact(503, null) },
      ] },
      { host: 'host-a', status: 'ok', entries: [{ kind: 'unowned-session', session: { name: 'pt-ws-test1-pane-p1-tab-cccc', ageMs: 10 * MIN } }] },
    ];
    internals(manager).orphanSweepDueAt = 0;
    await internals(manager).runOrphanSweep(Date.now());
    const lines = sent();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ to: 'root', kind: 'orphan-sweep' });
    expect(lines[0].message).toContain('pid 501 (tab tab-aaaa)');
    expect(lines[0].message).toContain('pid 503');
    expect(lines[0].message).toContain('host-a: 1 session no layout owns (pt-ws-test1-pane-p1-tab-cccc)');
    expect(lines[0].message).not.toContain('502');
    expect(lines[0].message).toContain('nothing was killed');
  });

  it('runs at most once an hour, and an empty list sends nothing', async () => {
    const { manager, sent } = await setup({ w: Date.now() - 10 * MIN });
    const { listOrphanEntries } = await import('@/lib/tab-orphans-service');
    internals(manager).orphanSweepDueAt = 0;
    const now = Date.now();
    await internals(manager).runOrphanSweep(now);
    await internals(manager).runOrphanSweep(now + 30 * MIN);
    expect(listOrphanEntries).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual([]);
    await internals(manager).runOrphanSweep(now + 61 * MIN);
    expect(listOrphanEntries).toHaveBeenCalledTimes(2);
  });
});
