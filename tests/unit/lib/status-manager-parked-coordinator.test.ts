import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import { ORCH_IDLE_HEARTBEAT_MS } from '@/lib/orchestration';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';
import { memoryLedgerTables } from './tab-events-harness';

// A coordinator whose last turn ended CHECKPOINTED: and that holds no lease, no worker, no job and no watch is parked:
// the keeper types no heartbeat into it. Seen 16 Nov: each heartbeat produced one more CHECKPOINTED: turn, which reset
// the idle episode, so the parked coordinator was typed into every ~11 min for good.

const fixture = vi.hoisted(() => ({
  getWorkspaceByIdCached: vi.fn(),
  getWorkspacesCached: vi.fn(),
  statusForTab: vi.fn(),
  leases: vi.fn(),
  watches: vi.fn(),
}));

vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: fixture.getWorkspaceByIdCached,
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: fixture.getWorkspacesCached,
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => ({ statusForTab: fixture.statusForTab }) }));
vi.mock('@/lib/lease-store', async (original) => ({ ...(await original<typeof import('@/lib/lease-store')>()), readLeaseEvidence: fixture.leases }));
vi.mock('@/lib/watch-store', async (original) => ({ ...(await original<typeof import('@/lib/watch-store')>()), readWatches: fixture.watches }));

const policyLock = (): IAutomatedPromptDispatcherDeps['withPolicyLock'] =>
  async (_workspaceId, _target, deliver) => deliver(async () => ({ ok: true as const }));

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

const STOP_SEQ = 41;
const coordinator = (marker: string | null, over: Partial<ITabStatusEntry> = {}): ITabStatusEntry => ({
  cliState: 'idle',
  workspaceId: 'ws-a',
  tabName: 'coordinator',
  tmuxSession: 'tmux-root',
  panelType: 'claude-code',
  agentProviderId: 'claude',
  lastEvent: { name: 'stop', at: Date.now(), seq: STOP_SEQ },
  eventSeq: STOP_SEQ,
  turnEnd: marker === null
    ? { kind: 'ready-for-review', at: Date.now(), seq: STOP_SEQ, transcript: true, openBackgroundTasks: 0, liveRegisteredJobs: 0, armedWatches: 0 }
    : { kind: 'turn-marker', at: Date.now(), seq: STOP_SEQ, marker: [marker] },
  ...over,
});

const lease = (workspaceId: string | null, name = 'epic:alpha') => ({
  name, kind: name.split(':')[0], resource: name.split(':').slice(1).join(':'), epic: null, note: null,
  holder: { workspaceId, tabId: 'root', tabName: 'coordinator', verified: true, admin: false },
  acquiredAt: '2026-11-16T02:00:00Z', renewedAt: '2026-11-16T02:00:00Z', ttlSeconds: null, expiresAt: null,
});

const setup = async (entry: ITabStatusEntry) => {
  const tables = memoryLedgerTables();
  const paste = vi.fn(async () => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_workspaceId, id) => tab(id)),
    withPolicyLock: policyLock(),
    hasSession: vi.fn(async () => true),
    paste,
  });
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(dispatcher, undefined, undefined, ...tables);
  manager.registerTab('root', entry);
  const runKeeper = (manager as unknown as { runOrchestratorKeeper: () => Promise<void> }).runOrchestratorKeeper.bind(manager);
  /** Two keeper passes one heartbeat window apart: the first opens the idle episode, the second may beat. */
  const window = async () => {
    await runKeeper();
    await vi.advanceTimersByTimeAsync(ORCH_IDLE_HEARTBEAT_MS + 60_000);
    await runKeeper();
  };
  const stallAlert = vi.spyOn(manager as unknown as { dispatchStallAlert: () => Promise<void> }, 'dispatchStallAlert').mockResolvedValue();
  return { paste, window, runKeeper, stallAlert, events: tables[0]() };
};

describe('a parked coordinator gets no heartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T03:00:00Z'));
    const ws = { id: 'ws-a', name: 'A', directories: ['/tmp'], orchestration: { enabled: true, orchestratorTabId: 'root' } };
    fixture.getWorkspaceByIdCached.mockResolvedValue(ws);
    fixture.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
    fixture.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
    fixture.leases.mockResolvedValue({ known: true, leases: [] });
    fixture.watches.mockResolvedValue({ watches: [] });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('types no heartbeat into a coordinator whose last turn ended CHECKPOINTED: and that holds nothing', async () => {
    const { paste, window } = await setup(coordinator('CHECKPOINTED: parked; resume from the handoff file'));
    await window();
    await window();
    expect(paste).not.toHaveBeenCalled();
  });

  it('the control: the same quiet coordinator after a DONE: or an unmarked turn still gets its heartbeat', async () => {
    for (const marker of ['DONE: stage 2 merged', null]) {
      const { paste, window } = await setup(coordinator(marker));
      await window();
      expect(paste).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ['a lease held by its workspace', () => fixture.leases.mockResolvedValue({ known: true, leases: [lease('ws-a')] })],
    ['an armed watch of its workspace', () => fixture.watches.mockResolvedValue({ watches: [{ id: 'w-1', workspaceId: 'ws-a', tabId: 'root' }] })],
    ['an unreadable lease store', () => fixture.leases.mockResolvedValue({ known: false })],
    ['an unreadable watch store', () => fixture.watches.mockRejectedValue(new Error('EACCES'))],
  ])('a CHECKPOINTED: coordinator with %s is not parked: the heartbeat goes out', async (_name, arrange) => {
    arrange();
    const { paste, window } = await setup(coordinator('CHECKPOINTED: parked'));
    await window();
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it('a lease or a watch of another workspace does not keep it awake', async () => {
    fixture.leases.mockResolvedValue({ known: true, leases: [lease('ws-b'), lease(null, 'merge:o/r')] });
    fixture.watches.mockResolvedValue({ watches: [{ id: 'w-1', workspaceId: 'ws-b', tabId: 'x' }] });
    const { paste, window } = await setup(coordinator('CHECKPOINTED: parked'));
    await window();
    expect(paste).not.toHaveBeenCalled();
  });

  it('a CHECKPOINTED: record of an older stop does not park: a newer prompt owns the tab', async () => {
    const { paste, window } = await setup(coordinator('CHECKPOINTED: parked', {
      lastEvent: { name: 'prompt-submit', at: Date.now(), seq: STOP_SEQ + 1 }, eventSeq: STOP_SEQ + 1,
    }));
    await window();
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it('the heartbeat comes back once a later turn ends without CHECKPOINTED:', async () => {
    const entry = coordinator('CHECKPOINTED: parked');
    const { paste, window } = await setup(entry);
    await window();
    expect(paste).not.toHaveBeenCalled();
    entry.lastEvent = { name: 'stop', at: Date.now(), seq: STOP_SEQ + 2 };
    entry.eventSeq = STOP_SEQ + 2;
    entry.turnEnd = { kind: 'turn-marker', at: Date.now(), seq: STOP_SEQ + 2, marker: ['BLOCKED: the gate is red'] };
    await window();
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it('a held num: or pool-cancel: reservation still parks', async () => {
    fixture.leases.mockResolvedValue({ known: true, leases: [lease('ws-a', 'num:o/r:adr:0049'), lease('ws-a', 'pool-cancel:abcdefghijklmnop')] });
    const { paste, window } = await setup(coordinator('CHECKPOINTED: parked'));
    await window();
    expect(paste).not.toHaveBeenCalled();
  });

  it.each(['merge:o/r', 'deploy:svc'])('a held %s lease does not park', async (name) => {
    fixture.leases.mockResolvedValue({ known: true, leases: [lease('ws-a', name)] });
    const { paste, window } = await setup(coordinator('CHECKPOINTED: parked'));
    await window();
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it('an urgent event for the coordinator that was not typed does not park (the heartbeat is its backstop)', async () => {
    const { paste, window, events } = await setup(coordinator('CHECKPOINTED: parked'));
    events.append({ workspaceId: 'ws-a', tabId: 'root', at: Date.now(), class: 'urgent', kind: 'turn-marker', text: 'worker ended: DONE: x', sourceTabId: 'worker' });
    await window();
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it('an undelivered urgent event for another tab, or a typed one for the coordinator, still parks', async () => {
    const { paste, window, events } = await setup(coordinator('CHECKPOINTED: parked'));
    events.append({ workspaceId: 'ws-a', tabId: 'worker', at: Date.now(), class: 'urgent', kind: 'turn-marker', text: 'a', sourceTabId: 'x' });
    events.append({ workspaceId: 'ws-a', tabId: 'root', at: Date.now(), class: 'urgent', kind: 'turn-marker', text: 'b', sourceTabId: 'x', deliveredAt: Date.now() });
    await window();
    expect(paste).not.toHaveBeenCalled();
  });

  it('a lease-held coordinator that answers each beat CHECKPOINTED: reaches beat 3 and the owner alert, no reset loop', async () => {
    fixture.leases.mockResolvedValue({ known: true, leases: [lease('ws-a')] });
    const entry = coordinator('CHECKPOINTED: parked');
    const { paste, runKeeper, stallAlert } = await setup(entry);
    let seq = STOP_SEQ;
    const answer = () => {
      seq += 2;
      entry.lastEvent = { name: 'stop', at: Date.now(), seq };
      entry.eventSeq = seq;
      entry.turnEnd = { kind: 'turn-marker', at: Date.now(), seq, marker: ['CHECKPOINTED: parked'] };
    };
    await runKeeper();
    for (let beat = 1; beat <= 5; beat += 1) {
      await vi.advanceTimersByTimeAsync(ORCH_IDLE_HEARTBEAT_MS + 60_000);
      await runKeeper();
      // The coordinator answers the beat half a minute later with another CHECKPOINTED: turn.
      await vi.advanceTimersByTimeAsync(30_000);
      answer();
    }
    expect(paste).toHaveBeenCalledTimes(1);
    expect(stallAlert).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a turn-marker record without a seq', { turnEnd: { kind: 'turn-marker' as const, at: 0, marker: ['CHECKPOINTED: parked'] } }],
    ['no last event', { lastEvent: null }],
  ])('%s does not park', async (_name, over) => {
    const { paste, window } = await setup(coordinator('CHECKPOINTED: parked', over as Partial<ITabStatusEntry>));
    await window();
    expect(paste).toHaveBeenCalledTimes(1);
  });
});
