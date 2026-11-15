import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import { LedgerStore } from '@/lib/ledger-store';
import type { ITab } from '@/types/terminal';
import type { ITabStatusEntry } from '@/types/status';

// ADR-0048: what the dormant sweep reads from the status manager. The end marker counts only on the current stop.

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: vi.fn(async () => undefined),
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: vi.fn(async () => ({ workspaces: [] })),
}));
// The curator's turn-end hook is fire-and-forget; its module chain must not load after this file's environment is gone.
vi.mock('@/lib/curator-service', () => ({ curatorOnUnmarkedTurnEnd: vi.fn() }));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => ({ statusForTab: vi.fn(), removeTab: vi.fn() }) }));
vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux')>()),
  getSessionPanePid: vi.fn(async () => null),
  getSessionCwd: vi.fn(async () => null),
  getAllPanesInfo: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

let ledger: LedgerStore;

const manager = async (events: () => import('@/lib/tab-events-store').TabEventsTable = () => ledger.tabEvents) => {
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste: vi.fn(async () => {}),
  });
  await import('@/lib/providers');
  const { StatusManager } = await import('@/lib/status-manager');
  const m = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}), events, () => ledger.tabTurns);
  return m;
};


const entry = (over: Partial<ITabStatusEntry> = {}): ITabStatusEntry => ({
  cliState: 'ready-for-review', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code', ...over,
});

beforeEach(async () => {
  mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-sm-dormant-'));
  ledger = new LedgerStore(':memory:');
});

afterEach(async () => {
  ledger.close();
  await fs.rm(mockHome.value, { recursive: true, force: true });
});

describe('StatusManager.dormantFacts', () => {
  it('answers null for a tab it does not know', async () => {
    expect(await (await manager()).dormantFacts('tab-none')).toBeNull();
    expect((await manager()).dormantGuard('tab-none')).toBeNull();
  });

  it.each([
    ['NEEDS-DECISION: [scope] ship it? (a) yes (b) no', 'NEEDS-DECISION'],
    ['BLOCKED: no credential', 'BLOCKED'],
    ['DONE: shipped', null],
  ] as const)('reads the waiting marker of the current stop: %s', async (line, expected) => {
    const m = await manager();
    m.registerTab('tab-w', entry({ eventSeq: 5, lastEvent: { name: 'stop', at: 1_000, seq: 5 }, turnEnd: { kind: 'turn-marker', at: 1_000, seq: 5, marker: ['notes', line] } }));
    expect((await m.dormantFacts('tab-w'))?.waitingMarker).toBe(expected);
  });

  it('ignores the marker of a stop a newer event replaced', async () => {
    const m = await manager();
    m.registerTab('tab-w', entry({ eventSeq: 6, lastEvent: { name: 'prompt-submit', at: 2_000, seq: 6 }, turnEnd: { kind: 'turn-marker', at: 1_000, seq: 5, marker: ['BLOCKED: x'] } }));
    expect((await m.dormantFacts('tab-w'))?.waitingMarker).toBeNull();
  });

  it('reports the event times, the seq, an open turn and no transcript handle', async () => {
    const m = await manager();
    m.registerTab('tab-w', entry({ cliState: 'idle', eventSeq: 3, lastEvent: { name: 'stop', at: 1_500, seq: 3 }, lastResumeOrStartedAt: 900 }));
    m.updateTabFromHook('tmux-w', 'prompt-submit');
    const facts = await m.dormantFacts('tab-w');
    expect(facts).toMatchObject({
      providerId: 'claude', lastResumeOrStartedAt: 900, turnOpen: true, retired: false, restarting: false, halted: false,
      seatPhase: null, seatAdvancing: false, snapshot: { read: 'none' }, heldDigests: { ok: true, value: 0 }, lastDeliveredAt: { ok: true, value: null },
    });
    expect(facts!.eventSeq).toBeGreaterThan(3);
    expect(m.dormantGuard('tab-w')).toEqual({ cliState: facts!.cliState, eventSeq: facts!.eventSeq, retired: false, restarting: false });
  });

  it('turns a tab-event log that throws into a failed read, never zero', async () => {
    const m = await manager(() => { throw new Error('SQLITE_CORRUPT'); });
    m.registerTab('tab-w', entry());
    const facts = await m.dormantFacts('tab-w');
    expect(facts?.heldDigests).toEqual({ ok: false, error: 'SQLITE_CORRUPT' });
    expect(facts?.lastDeliveredAt).toEqual({ ok: false, error: 'SQLITE_CORRUPT' });
  });
});
