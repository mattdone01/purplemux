import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import { LedgerStore } from '@/lib/ledger-store';
import type { ITurnEndRow } from '@/lib/turn-end-row';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// F6, folding in F10 steps 1 and 2 (design check (2) ruling, 2026-11-10), through the status manager: a held stop, a
// row applied as the end line with the classifier in shadow, the cap, a WAITING stop, the payload tail, the kill switch
// and a block that never reached the agent.

const mockHome = vi.hoisted(() => ({ value: '' }));
const workspaceStore = vi.hoisted(() => ({ getWorkspaceByIdCached: vi.fn(), getWorkspacesCached: vi.fn() }));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn(), removeTab: vi.fn() }));
const pane = vi.hoisted(() => ({ text: '' as string | null }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: workspaceStore.getWorkspaceByIdCached,
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: workspaceStore.getWorkspacesCached,
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => liveness }));
vi.mock('@/lib/curator-service', () => ({ curatorOnUnmarkedTurnEnd: vi.fn() }));
vi.mock('@/lib/capture-at-width', () => ({ capturePaneAtWidth: vi.fn(async () => pane.text) }));
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

const SESSION = 'sess-w';
const EMPTY_CLAUDE = 'output\n────────\n❯ \n────────\n';
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 5000 });
const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

const claudeEnd = (text: string) => ({
  type: 'assistant', timestamp: '2026-11-10T02:00:00.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
});

const setup = async (opts: { scoped?: boolean; transcriptText?: string } = {}) => {
  const ws = { id: 'ws-1', name: 'ws', directories: [mockHome.value], orchestration: { enabled: true, orchestratorTabId: 'root' } };
  workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
  workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
  await fs.mkdir(path.join(mockHome.value, '.purplemux'), { recursive: true });
  await fs.writeFile(path.join(mockHome.value, '.purplemux', 'event-scopes.json'), JSON.stringify({
    scopes: opts.scoped === false ? [] : [{
      workspaceId: 'ws-1', tabId: 'w', epic: 'e', story: 'F6', dependsOn: [], attempt: 1, declaredBy: { workspaceId: 'ws-1', tabId: 'root' }, declaredAt: 0,
    }],
  }));
  const transcript = path.join(mockHome.value, 'claude', 's.jsonl');
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, `${JSON.stringify(claudeEnd(opts.transcriptText ?? 'Gate green.\n\nDONE: shipped'))}\n`);
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  await import('@/lib/providers');
  const store = new LedgerStore(':memory:');
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}),
    () => store.tabEvents, () => store.tabTurns, () => store.turnEnds);
  // The coordinator window is pinned in coordinator-window.test.ts; here the orchestrator is only the nudge target.
  (await import('@/lib/coordinator-window')).configureCoordinatorWindow({
    now: () => Date.now(), isCoordinator: async () => false, lastGoverned: () => null, oldestDigestAt: () => null,
  });
  manager.registerTab('root', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'root', tmuxSession: 'tmux-root', panelType: 'claude-code' });
  const worker: ITabStatusEntry = {
    cliState: 'idle', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code', agentProviderId: 'claude',
    jsonlPath: transcript, agentSessionId: SESSION,
  };
  manager.registerTab('w', worker);
  manager.updateTabFromHook('tmux-w', 'prompt-submit');
  const internals = manager as unknown as { turnEndSourceRow: boolean; checkUndeliveredBlocks: (now: number) => Promise<void> };
  const nudges = () => paste.mock.calls.map(([, message]) => message);
  const stop = (message: string | null) => manager.decideClaudeStop('tmux-w', { hookEvent: 'Stop', sessionId: SESSION, message }, false);
  const row = (over: Partial<ITurnEndRow> = {}): ITurnEndRow => ({
    sessionId: SESSION, turnId: store.turnEnds.currentTurn(SESSION)!.turnId, workspaceId: 'ws-1', tabId: 'w', seatRole: 'builder', story: 'F6',
    attempt: 1, verdict: 'DONE', head: 'c'.repeat(40), gateLog: '/g.log', gateVerdict: 'VALID', reason: 'shipped', source: 'done',
    unreportedReason: null, at: Date.now(), consumedAt: null, ...over,
  });
  return { manager, store, worker, internals, nudges, stop, row };
};

describe('the typed turn end through the status manager (F6; F10 steps 1-2)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-turn-end-row-'));
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
    pane.text = EMPTY_CLAUDE;
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('a live prompt-submit opens a turn; a stop with no row is held; the row written after it is the end line', async () => {
    const { manager, store, nudges, stop, row } = await setup();
    expect(store.turnEnds.currentTurn(SESSION)).toEqual({ turnId: 1, blocks: 0 });
    expect(await stop('Gate green.\n\nDONE: shipped')).toMatchObject({ kind: 'block' });
    expect(store.turnEnds.currentTurn(SESSION)?.blocks).toBe(1);
    store.turnEnds.put(row());
    expect(await stop('Gate green.\n\nDONE: shipped')).toMatchObject({ kind: 'row' });
    manager.updateTabFromHook('tmux-w', 'stop');
    await waitFor(() => expect(nudges()).toHaveLength(1));
    expect(nudges()[0]).toContain(`ended: DONE: shipped (story F6, head ${'c'.repeat(12)}, gate VALID)`);
    expect(store.turnEnds.unconsumed(SESSION, 1)).toBeNull();
    expect(store.turnEnds.list('ws-1', 0)).toEqual([expect.objectContaining({ verdict: 'DONE', consumedAt: expect.any(Number) })]);
  });

  it('after two holds the third stop goes through: one UNREPORTED cap row and the classifier\'s verdict', async () => {
    const { manager, store, nudges, stop } = await setup();
    expect(await stop('DONE: shipped')).toMatchObject({ kind: 'block' });
    expect(await stop('DONE: shipped')).toMatchObject({ kind: 'block' });
    expect(await stop('DONE: shipped')).toEqual({ kind: 'unreported', reason: 'cap', escalation: null });
    manager.updateTabFromHook('tmux-w', 'stop');
    await waitFor(() => expect(nudges()).toHaveLength(1));
    expect(nudges()[0]).toContain('ended: DONE: shipped');
    expect(store.turnEnds.list('ws-1', 0)).toEqual([expect.objectContaining({ verdict: 'UNREPORTED', unreportedReason: 'cap' })]);
  });

  it('never holds a WAITING stop: a markerless stop with a live job needs no row', async () => {
    const { store, stop } = await setup({ transcriptText: 'gate launched' });
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: true }] });
    expect(await stop('gate launched, waiting on it')).toMatchObject({ kind: 'classifier', why: 'waiting on open work' });
    expect(store.turnEnds.currentTurn(SESSION)?.blocks).toBe(0);
  });

  it('F10 step 1: the stop\'s own message is the tail when the transcript has not caught up', async () => {
    const { manager, nudges, stop } = await setup({ scoped: false, transcriptText: 'still writing the summary' });
    expect(await stop('Summary.\n\nBLOCKED: gate red on lint')).toMatchObject({ kind: 'classifier', why: 'unscoped' });
    manager.updateTabFromHook('tmux-w', 'stop');
    await waitFor(() => expect(nudges()).toHaveLength(1));
    expect(nudges()[0]).toContain('ended: BLOCKED: gate red on lint');
  });

  it('the kill switch turn-end.source=classifier holds nothing', async () => {
    const { internals, stop } = await setup();
    internals.turnEndSourceRow = false;
    expect(await stop('DONE: shipped')).toMatchObject({ kind: 'classifier', why: 'turn-end.source=classifier' });
  });

  it('a hold no hook event confirmed, with the agent at its prompt, applies as UNREPORTED block-undelivered', async () => {
    const { internals, store, nudges, stop } = await setup();
    expect(await stop('DONE: shipped')).toMatchObject({ kind: 'block' });
    pane.text = 'output\n────────\n❯ half typed\n────────\n';
    await internals.checkUndeliveredBlocks(Date.now() + 16_000);
    expect(nudges()).toEqual([]);
    pane.text = EMPTY_CLAUDE;
    await internals.checkUndeliveredBlocks(Date.now() + 16_000);
    await waitFor(() => expect(nudges()).toHaveLength(1));
    expect(store.turnEnds.list('ws-1', 0)).toEqual([expect.objectContaining({ verdict: 'UNREPORTED', unreportedReason: 'block-undelivered' })]);
  });

  it('a replayed stop is never held: with no row it is UNREPORTED not-blockable:replayed', async () => {
    const { manager, store } = await setup();
    expect(await manager.decideClaudeStop('tmux-w', { hookEvent: 'Stop', sessionId: SESSION, message: 'DONE: x' }, true))
      .toEqual({ kind: 'unreported', reason: 'not-blockable:replayed', escalation: null });
    expect(store.turnEnds.currentTurn(SESSION)?.blocks).toBe(0);
    expect(await manager.decideClaudeStop('tmux-w', { hookEvent: 'StopFailure', sessionId: SESSION, message: 'API Error' }, false))
      .toMatchObject({ kind: 'unreported', reason: 'not-blockable:stop-failure' });
  });
});
