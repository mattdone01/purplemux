import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DormantSweeper, type IDormantGuard, type IDormantSweeperDeps, type IDormantWorkspace } from '@/lib/dormant-sweeper';
import type { IDormantPassReads } from '@/lib/dormant-sweep';
import type { IDormantStatusFacts } from '@/types/dormant';
import type { IGitFacts } from '@/types/rotation-checkpoint';
import type { ITab } from '@/types/terminal';

// ADR-0048: the sweep's passes. A free dormant tab closes on the second pass in a row (same eventSeq), at most 5 a
// pass, oldest first; the close re-reads the tab under the layout lock; a held tab is reported once a day.

const MIN = 60_000;
const HOUR = 60 * MIN;
const START = Date.parse('2026-11-16T00:00:00Z');

const status = (over: Partial<IDormantStatusFacts> = {}): IDormantStatusFacts => ({
  cliState: 'idle',
  panelType: 'claude-code',
  providerId: 'claude',
  eventSeq: 7,
  lastEventAt: START - 8 * HOUR,
  busySince: null,
  lastResumeOrStartedAt: null,
  retired: false,
  restarting: false,
  halted: false,
  seatPhase: null,
  seatAdvancing: false,
  turnOpen: false,
  waitingMarker: null,
  agentSessionId: 'sess-1',
  jsonlPath: '/tmp/s.jsonl',
  snapshot: { read: 'ok', lastEntryTs: null, backgroundActivityAt: null, openBackgroundTasks: 0, transcriptRead: true },
  heldDigests: { ok: true, value: 0 },
  lastDeliveredAt: { ok: true, value: null },
  ...over,
});

const clean: IGitFacts = { kind: 'ok', cwd: '/w', worktree: '/w', branch: 'feat/x', head: 'abc', baseRef: null, base: null, dirty: 0 };

interface IWorld {
  now: number;
  config: Record<string, string>;
  workspaces: IDormantWorkspace[];
  uncertain: Set<string>;
  statuses: Map<string, IDormantStatusFacts>;
  guards: Map<string, IDormantGuard>;
  git: Map<string, IGitFacts | Error>;
  pass: IDormantPassReads;
  /** The layout's current copy of each tab, as `closeTab` would read it under its lock. */
  layoutTab: Map<string, ITab>;
  closeError: Error | null;
  noteError: Error | null;
  /** The registry's orchestrator as `closeTab` reads it under the mapping lease; an Error: the registry did not read. */
  orchestratorTabId: string | null | Error;
  /** Tabs the layout holds besides the candidates (another tab's reportsTo). */
  extraLayoutTabs: ITab[];
}

let world: IWorld;
const closes: string[] = [];
const notes: Array<{ workspaceId: string; subject: string; body: string }> = [];
const audits: Array<Record<string, unknown>> = [];
const lines: string[] = [];

const tabOf = (id: string, over: Partial<ITab> = {}): ITab => ({ id, sessionName: `s-${id}`, name: `n-${id}`, order: 0, panelType: 'claude-code', ...over });

const addTab = (workspaceId: string, tab: ITab, facts: Partial<IDormantStatusFacts> = {}, extra: { isOrchestrator?: boolean } = {}) => {
  let ws = world.workspaces.find((w) => w.workspaceId === workspaceId);
  if (!ws) {
    ws = { workspaceId, tabs: [] };
    world.workspaces.push(ws);
  }
  ws.tabs.push({ workspaceId, paneId: 'pane-1', tab, isOrchestrator: !!extra.isOrchestrator, reportsTarget: false });
  const s = status(facts);
  world.statuses.set(tab.id, s);
  world.guards.set(tab.id, { cliState: s.cliState, eventSeq: s.eventSeq, retired: false, restarting: false });
  world.layoutTab.set(tab.id, tab);
};

const deps = (): IDormantSweeperDeps => ({
  now: () => world.now,
  config: async (key) => world.config[key] ?? null,
  listWorkspaces: async () => ({ workspaces: world.workspaces, uncertainWorkspaceIds: world.uncertain }),
  passReads: vi.fn(async () => world.pass),
  workspaceReads: () => ({ ledger: { ok: true, value: new Map() }, missionWork: { ok: true, value: new Map() } }),
  status: async (tabId) => world.statuses.get(tabId) ?? null,
  pane: async () => ({ cwd: '/w', sessionCreatedAt: START - 30 * HOUR }),
  jobs: async () => 0,
  gitFacts: async (_host, cwd) => {
    const found = world.git.get(cwd) ?? clean;
    if (found instanceof Error) throw found;
    return found;
  },
  guard: (tabId) => world.guards.get(tabId) ?? null,
  close: async (_ws, _pane, tabId, refuseIf) => {
    if (world.closeError) throw world.closeError;
    const current = world.layoutTab.get(tabId);
    if (!current) return { ok: false };
    const layoutTabs = [...world.layoutTab.values(), ...world.extraLayoutTabs];
    const orchestrator = world.orchestratorTabId instanceof Error
      ? { ok: false as const, error: world.orchestratorTabId.message }
      : { ok: true as const, tabId: world.orchestratorTabId };
    const refused = refuseIf(current, {
      layout: { root: { type: 'pane', id: 'pane-1', tabs: layoutTabs, activeTabId: null }, activePaneId: 'pane-1', updatedAt: '' },
      orchestrator,
    });
    if (refused) return { ok: false, refused };
    closes.push(tabId);
    world.layoutTab.delete(tabId);
    for (const ws of world.workspaces) ws.tabs = ws.tabs.filter((c) => c.tab.id !== tabId);
    return { ok: true };
  },
  note: async (workspaceId, subject, body) => {
    if (world.noteError) throw world.noteError;
    notes.push({ workspaceId, subject, body });
  },
  audit: async (entry) => {
    audits.push(entry);
  },
  log: { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) },
});

const emptyPass = (): IDormantPassReads => ({
  leases: { ok: true, value: [] },
  watches: { ok: true, value: [] },
  inbox: { ok: true, value: [] },
  notes: { ok: true, value: [] },
  grants: { ok: true, value: [] },
});

const outcomes = (results: Awaited<ReturnType<DormantSweeper['sweep']>>) =>
  Object.fromEntries((results ?? []).map((r) => [r.tabId, r.outcome]));

beforeEach(() => {
  world = {
    now: START,
    config: { 'tabs.dormant.mode': 'close' },
    workspaces: [],
    uncertain: new Set(),
    statuses: new Map(),
    guards: new Map(),
    git: new Map(),
    pass: emptyPass(),
    layoutTab: new Map(),
    closeError: null,
    noteError: null,
    orchestratorTabId: null,
    extraLayoutTabs: [],
  };
  closes.length = 0;
  notes.length = 0;
  audits.length = 0;
  lines.length = 0;
});

describe('close mode', () => {
  it('confirms on the first pass and closes on the second, with one audit line, one log line and one note', async () => {
    addTab('ws-a', tabOf('tab-1'));
    const sweeper = new DormantSweeper(deps());
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'confirming' });
    expect(closes).toEqual([]);
    world.now += 10 * MIN;
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'closed' });
    expect(closes).toEqual(['tab-1']);
    const closeAudits = audits.filter((a) => a.event === 'dormant-close');
    expect(closeAudits).toHaveLength(1);
    expect(closeAudits[0]).toMatchObject({ workspaceId: 'ws-a', tabId: 'tab-1', state: 'idle', lastActivityAt: START - 8 * HOUR, source: 'last hook event', thresholdHours: 6, worktree: '/w: clean on feat/x', agentSessionId: 'sess-1' });
    expect(lines.filter((l) => l.includes('closed:'))).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(notes[0].workspaceId).toBe('ws-a');
    expect(notes[0].subject).toBe('dormant tab closed: n-tab-1');
    expect(notes[0].body).toContain('n-tab-1 (tab-1): no turn for 8.2 h (threshold 6 h), state idle.');
    expect(notes[0].body).toContain('Last activity: last hook event, 2026-11-15T16:00:00.000Z; agent session sess-1; transcript /tmp/s.jsonl.');
    expect(notes[0].body).toContain('Checked, none held: orchestrator, keep,');
    expect(notes[0].body).toContain('Worktree: /w: clean on feat/x.');
  });

  it('sends one note per workspace per pass, listing every tab it closed', async () => {
    addTab('ws-a', tabOf('tab-1'));
    addTab('ws-a', tabOf('tab-2'));
    addTab('ws-b', tabOf('tab-3'));
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    await sweeper.sweep();
    expect(closes.sort()).toEqual(['tab-1', 'tab-2', 'tab-3']);
    expect(notes.map((n) => [n.workspaceId, n.subject])).toEqual([['ws-a', 'dormant tabs closed: 2'], ['ws-b', 'dormant tab closed: n-tab-3']]);
    expect(notes[0].body).toContain('(tab-1)');
    expect(notes[0].body).toContain('(tab-2)');
  });

  it('starts the confirm again when the tab acted between the two passes', async () => {
    addTab('ws-a', tabOf('tab-1'));
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    world.statuses.set('tab-1', status({ eventSeq: 8 }));
    world.guards.set('tab-1', { cliState: 'idle', eventSeq: 8, retired: false, restarting: false });
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'confirming' });
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'closed' });
  });

  it('starts the confirm again when the tab was active in between', async () => {
    addTab('ws-a', tabOf('tab-1'));
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    world.statuses.set('tab-1', status({ cliState: 'busy' }));
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'active' });
    world.statuses.set('tab-1', status());
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'confirming' });
  });

  it('refuses the close when a turn was recorded after the judgement, and closes nothing', async () => {
    addTab('ws-a', tabOf('tab-1'));
    // Between the second judgement and the close, a send records its pending turn under the mapping lock.
    const original = deps().close;
    const racing: IDormantSweeperDeps = {
      ...deps(),
      close: async (ws, pane, tabId, refuseIf) => {
        world.layoutTab.set(tabId, tabOf(tabId, { orchestrationActivity: { sessionName: 's', runtimeGeneration: 'g', turn: { generation: 't', runtimeGeneration: 'g', at: world.now } } }));
        return original(ws, pane, tabId, refuseIf);
      },
    };
    const raced = new DormantSweeper(racing);
    await raced.sweep();
    expect(outcomes(await raced.sweep())).toEqual({ 'tab-1': 'close-refused' });
    expect(closes).toEqual([]);
    expect(notes).toEqual([]);
    expect(audits.filter((a) => a.event === 'dormant-close-refused')).toEqual([expect.objectContaining({ tabId: 'tab-1', reason: 'orchestration-pending' })]);
  });

  it.each([
    ['a keep set after the judgement', { keep: { until: null, reason: 'mine', at: 0 } }, null, 'keep'],
    ['a new event seq', {}, { eventSeq: 99 }, 'activity since the judgement'],
    ['a busy state', {}, { cliState: 'busy' }, 'state busy'],
    ['a restart', {}, { restarting: true }, 'restarting'],
    ['a close in flight', {}, { retired: true }, 'closing'],
  ] as const)('refuses the close on %s', async (_label, tabOver, guardOver, reason) => {
    addTab('ws-a', tabOf('tab-1'));
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    world.layoutTab.set('tab-1', tabOf('tab-1', tabOver as Partial<ITab>));
    if (guardOver) world.guards.set('tab-1', { ...world.guards.get('tab-1')!, ...guardOver });
    // The judgement itself still sees the old facts (a race inside one pass).
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'close-refused' });
    expect(closes).toEqual([]);
    expect(audits.at(-1)).toMatchObject({ event: 'dormant-close-refused', reason });
  });

  it('refuses the close when the tab became the orchestrator, or another tab reports to it, after the judgement', async () => {
    addTab('ws-a', tabOf('tab-1'));
    addTab('ws-a', tabOf('tab-2'));
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    world.orchestratorTabId = 'tab-1';
    world.extraLayoutTabs = [tabOf('tab-lead', { panelType: 'terminal', reportsTo: 'tab-2' })];
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'close-refused', 'tab-2': 'close-refused' });
    expect(closes).toEqual([]);
    expect(audits.filter((a) => a.event === 'dormant-close-refused').map((a) => [a.tabId, a.reason]))
      .toEqual([['tab-1', 'orchestrator'], ['tab-2', 'reports-target']]);
  });

  it('refuses the close when the registry does not read under the lease', async () => {
    addTab('ws-a', tabOf('tab-1'));
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    world.orchestratorTabId = new Error('Invalid workspaces registry');
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'close-refused' });
    expect(audits.at(-1)).toMatchObject({ event: 'dormant-close-refused', reason: 'orchestrator-unreadable' });
  });

  it('starts the confirm again after a close that threw', async () => {
    addTab('ws-a', tabOf('tab-1'));
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    world.closeError = new Error('remote host did not answer');
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'close-failed' });
    world.closeError = null;
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'confirming' });
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'closed' });
  });

  it.each(['report', 'off'])('starts the confirm again after a %s pass in between', async (mode) => {
    addTab('ws-a', tabOf('tab-1'));
    const sweeper = new DormantSweeper(deps());
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'confirming' });
    world.config = { 'tabs.dormant.mode': mode };
    await sweeper.sweep();
    world.config = { 'tabs.dormant.mode': 'close' };
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'confirming' });
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'closed' });
  });

  it('closes at most 5 a pass, oldest activity first, and defers the rest', async () => {
    for (let i = 1; i <= 7; i++) addTab('ws-a', tabOf(`tab-${i}`), { lastEventAt: START - (10 + i) * HOUR });
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    const second = outcomes(await sweeper.sweep());
    expect(closes).toEqual(['tab-7', 'tab-6', 'tab-5', 'tab-4', 'tab-3']);
    expect(second['tab-2']).toBe('close-deferred');
    expect(second['tab-1']).toBe('close-deferred');
    expect(audits.filter((a) => a.event === 'dormant-close-deferred').map((a) => a.tabId)).toEqual(['tab-2', 'tab-1']);
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'closed', 'tab-2': 'closed' });
  });

  it('audits a close that throws and goes on', async () => {
    addTab('ws-a', tabOf('tab-1'));
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    world.closeError = new Error('remote host did not answer');
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'close-failed' });
    expect(audits.at(-1)).toMatchObject({ event: 'dormant-close-failed', tabId: 'tab-1', error: 'remote host did not answer' });
  });

  it('audits a note that fails, after the close', async () => {
    addTab('ws-a', tabOf('tab-1'));
    world.noteError = new Error('note-limit');
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    await sweeper.sweep();
    expect(closes).toEqual(['tab-1']);
    expect(audits.at(-1)).toMatchObject({ event: 'dormant-close-note-failed', workspaceId: 'ws-a', tabIds: ['tab-1'], error: 'note-limit' });
    expect(lines.at(-1)).toBe('dormant-close note to ws-a failed: note-limit');
  });
});

describe('holds are reported, never closed', () => {
  it('never closes the workspace orchestrator', async () => {
    addTab('ws-a', tabOf('tab-orch'), {}, { isOrchestrator: true });
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-orch': 'held' });
    expect(closes).toEqual([]);
  });

  it('keeps a tab with a keep mark open', async () => {
    addTab('ws-a', tabOf('tab-1', { keep: { until: START + 2 * HOUR, reason: 'review', at: START - 20 * HOUR } }));
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'held' });
  });

  it('holds a dirty worktree and a worktree it cannot read', async () => {
    addTab('ws-a', tabOf('tab-1'));
    world.git.set('/w', { ...clean, dirty: 2 });
    const sweeper = new DormantSweeper(deps());
    const first = await sweeper.sweep();
    expect(first?.[0]).toMatchObject({ outcome: 'held', holds: ['worktree-dirty (2)'] });
    world.git.set('/w', new Error('ssh: connect timed out'));
    world.now += 25 * HOUR;
    expect((await sweeper.sweep())?.[0]).toMatchObject({ outcome: 'held', holds: ['worktree-unreadable'] });
  });

  it('reports a held tab once in 24 h, whatever its holds do, then again', async () => {
    addTab('ws-a', tabOf('tab-1'), { waitingMarker: 'NEEDS-DECISION' });
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    world.statuses.set('tab-1', status({ waitingMarker: 'NEEDS-DECISION', turnOpen: true }));
    world.now += 10 * MIN;
    await sweeper.sweep();
    world.statuses.set('tab-1', status({ waitingMarker: 'NEEDS-DECISION' }));
    world.now += 10 * MIN;
    await sweeper.sweep();
    expect(audits.filter((a) => a.event === 'dormant-held')).toHaveLength(1);
    expect(lines.filter((l) => l.includes('held, not closed'))).toEqual([
      'dormant tab n-tab-1 (tab-1) in ws-a held, not closed: last activity 8.0 h (last hook event, 2026-11-15T16:00:00.000Z); holds: needs-decision',
    ]);
    world.now = START + 24 * HOUR;
    await sweeper.sweep();
    expect(audits.filter((a) => a.event === 'dormant-held')).toHaveLength(2);
  });

  it('never judges a busy or needs-input tab, and reports nothing for it', async () => {
    addTab('ws-a', tabOf('tab-busy'), { cliState: 'busy' });
    addTab('ws-a', tabOf('tab-ask'), { cliState: 'needs-input' });
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-busy': 'active', 'tab-ask': 'active' });
    expect(audits).toEqual([]);
  });
});

describe('report mode, off mode and what the pass skips', () => {
  it('reports would-close once a day and closes nothing', async () => {
    world.config = { 'tabs.dormant.mode': 'report' };
    addTab('ws-a', tabOf('tab-1'));
    const sweeper = new DormantSweeper(deps());
    for (let i = 0; i < 4; i++) {
      expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'would-close' });
      world.now += 10 * MIN;
    }
    expect(closes).toEqual([]);
    expect(audits.filter((a) => a.event === 'dormant-would-close')).toHaveLength(1);
    expect(lines.filter((l) => l.includes('would close'))).toEqual([
      'dormant tab n-tab-1 (tab-1) in ws-a would close (mode report): last activity 8.0 h (last hook event, 2026-11-15T16:00:00.000Z), state idle; worktree /w: clean on feat/x',
    ]);
  });

  it('reads no store in off mode', async () => {
    world.config = { 'tabs.dormant.mode': 'off' };
    addTab('ws-a', tabOf('tab-1'));
    const d = deps();
    expect(await new DormantSweeper(d).sweep()).toEqual([]);
    expect(d.passReads).not.toHaveBeenCalled();
  });

  it('defaults to report when nothing is configured', async () => {
    world.config = {};
    addTab('ws-a', tabOf('tab-1'));
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'would-close' });
  });

  it('lets one workspace close while the fleet reports', async () => {
    world.config = { 'tabs.dormant.mode': 'report', 'tabs.dormant.mode.ws-b': 'close' };
    addTab('ws-a', tabOf('tab-1'));
    addTab('ws-b', tabOf('tab-2'));
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-1': 'would-close', 'tab-2': 'closed' });
  });

  it('skips a workspace whose layout did not read, and a tab the StatusManager does not know', async () => {
    addTab('ws-a', tabOf('tab-1'));
    addTab('ws-b', tabOf('tab-2'));
    world.uncertain.add('ws-a');
    world.statuses.delete('tab-2');
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    expect(outcomes(await sweeper.sweep())).toEqual({ 'tab-2': 'active' });
    expect(closes).toEqual([]);
  });

  it('skips a terminal or browser tab', async () => {
    addTab('ws-a', tabOf('tab-sh', { panelType: 'terminal' }));
    addTab('ws-a', tabOf('tab-web', { panelType: 'web-browser' }));
    const sweeper = new DormantSweeper(deps());
    await sweeper.sweep();
    expect(await sweeper.sweep()).toEqual([]);
  });

  it('runs one pass at a time', async () => {
    addTab('ws-a', tabOf('tab-1'));
    const sweeper = new DormantSweeper(deps());
    const [a, b] = await Promise.all([sweeper.sweep(), sweeper.sweep()]);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });
});
