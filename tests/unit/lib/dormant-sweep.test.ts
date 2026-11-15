import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DORMANT_HOURS,
  checkKeepInput,
  holdsOf,
  judgeActivity,
  parseDormantHours,
  parseDormantMode,
  parseKeepUntil,
  readDormantPolicy,
  worktreeVerdict,
  type IDormantHoldInput,
  type IDormantPane,
  type IDormantPassReads,
  type IDormantWorkspaceReads,
} from '@/lib/dormant-sweep';
import type { IDormantStatusFacts } from '@/types/dormant';
import type { IGitFacts } from '@/types/rotation-checkpoint';
import type { ITab } from '@/types/terminal';

// ADR-0048: the dormant-tab sweep's pure parts. Each hold keeps a dormant tab open and is named; each read that
// fails is a hold; the policy never reads a broken value as `close`.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-16T00:00:00Z');

const statusFacts = (over: Partial<IDormantStatusFacts> = {}): IDormantStatusFacts => ({
  cliState: 'idle',
  panelType: 'claude-code',
  providerId: 'claude',
  eventSeq: 7,
  lastEventAt: NOW - 8 * HOUR,
  busySince: null,
  lastResumeOrStartedAt: NOW - 9 * HOUR,
  retired: false,
  restarting: false,
  halted: false,
  seatPhase: null,
  seatAdvancing: false,
  turnOpen: false,
  waitingMarker: null,
  agentSessionId: 'sess-1',
  jsonlPath: '/tmp/s.jsonl',
  snapshot: { read: 'ok', lastEntryTs: NOW - 8 * HOUR, backgroundActivityAt: null, openBackgroundTasks: 0, transcriptRead: true },
  heldDigests: { ok: true, value: 0 },
  lastDeliveredAt: { ok: true, value: null },
  ...over,
});

const tab = (over: Partial<ITab> = {}): ITab => ({ id: 'tab-w1', sessionName: 's-w1', name: 'worker-1', order: 0, panelType: 'claude-code', ...over });

const emptyPass = (): IDormantPassReads => ({
  leases: { ok: true, value: [] },
  watches: { ok: true, value: [] },
  inbox: { ok: true, value: [] },
  notes: { ok: true, value: [] },
  grants: { ok: true, value: [] },
});

const emptyWorkspace = (): IDormantWorkspaceReads => ({
  ledger: { ok: true, value: new Map() },
  missionWork: { ok: true, value: new Map() },
});

const holdInput = (over: Partial<IDormantHoldInput> = {}): IDormantHoldInput => ({
  candidate: { workspaceId: 'ws-a', paneId: 'pane-1', tab: tab(), isOrchestrator: false, reportsTarget: false },
  status: statusFacts(),
  pass: emptyPass(),
  workspace: emptyWorkspace(),
  jobs: { ok: true, value: 0 },
  ...over,
});

const config = (values: Record<string, string>, failing: string[] = []) => async (key: string): Promise<string | null> => {
  if (failing.includes(key)) throw new Error('config-store-unreadable');
  return Object.hasOwn(values, key) ? values[key] : null;
};

describe('policy: mode and hours (ADR-0048 §4)', () => {
  it('parses each mode and refuses any other word', () => {
    expect(parseDormantMode('close').mode).toBe('close');
    expect(parseDormantMode(' report ').mode).toBe('report');
    expect(parseDormantMode('CLOSE')).toEqual({ mode: null, reason: 'tabs.dormant.mode is "CLOSE", not one of off | report | close' });
    expect(parseDormantMode(null)).toEqual({ mode: null, reason: null });
  });

  it('parses hours in 1..168 only', () => {
    expect(parseDormantHours('6').hours).toBe(6);
    expect(parseDormantHours('1.5').hours).toBe(1.5);
    expect(parseDormantHours('0').hours).toBeNull();
    expect(parseDormantHours('169').hours).toBeNull();
    expect(parseDormantHours('6h').reason).toMatch(/not a number of hours/);
  });

  it('defaults to report and 6 h when nothing is set', async () => {
    expect(await readDormantPolicy(config({}), 'ws-a')).toEqual({ mode: 'report', hours: DEFAULT_DORMANT_HOURS, modeSource: 'default', hoursSource: 'default', reasons: [] });
  });

  it('reads the fleet mode and hours', async () => {
    const policy = await readDormantPolicy(config({ 'tabs.dormant.mode': 'close', 'tabs.dormant.hours': '12' }), 'ws-a');
    expect(policy).toMatchObject({ mode: 'close', hours: 12, modeSource: 'fleet-config', hoursSource: 'fleet-config' });
  });

  it('lets the workspace key win over the fleet key', async () => {
    const policy = await readDormantPolicy(config({ 'tabs.dormant.mode': 'close', 'tabs.dormant.mode.ws-a': 'off' }), 'ws-a');
    expect(policy).toMatchObject({ mode: 'off', modeSource: 'workspace-config' });
  });

  it('reads an invalid fleet mode as report, with the reason', async () => {
    const policy = await readDormantPolicy(config({ 'tabs.dormant.mode': 'yes' }), 'ws-a');
    expect(policy.mode).toBe('report');
    expect(policy.modeSource).toBe('default-invalid');
    expect(policy.reasons).toEqual(['tabs.dormant.mode is "yes", not one of off | report | close']);
  });

  it('never lets an invalid workspace mode fall through to a fleet close', async () => {
    const policy = await readDormantPolicy(config({ 'tabs.dormant.mode': 'close', 'tabs.dormant.mode.ws-a': 'clsoe' }), 'ws-a');
    expect(policy).toMatchObject({ mode: 'report', modeSource: 'default-invalid' });
  });

  it('reads an unreadable config as report', async () => {
    const policy = await readDormantPolicy(config({}, ['tabs.dormant.mode.ws-a']), 'ws-a');
    expect(policy).toMatchObject({ mode: 'report', modeSource: 'default-unreadable' });
    expect(policy.reasons[0]).toMatch(/tabs.dormant.mode.ws-a unreadable/);
  });

  it('holds a close at report when the hours cannot be read', async () => {
    const policy = await readDormantPolicy(config({ 'tabs.dormant.mode': 'close' }, ['tabs.dormant.hours']), 'ws-a');
    expect(policy).toMatchObject({ mode: 'report', modeSource: 'default-unreadable', hours: 6, hoursSource: 'default-unreadable' });
  });

  it('serves 6 h for an invalid hours value and keeps the mode', async () => {
    const policy = await readDormantPolicy(config({ 'tabs.dormant.mode': 'close', 'tabs.dormant.hours': '999' }), 'ws-a');
    expect(policy).toMatchObject({ mode: 'close', hours: 6, hoursSource: 'default-invalid' });
  });
});

describe('keep mark input (ADR-0048 §6)', () => {
  it('parses a duration and an ISO time with a zone', () => {
    expect(parseKeepUntil('12h', NOW)).toEqual({ ok: true, until: NOW + 12 * HOUR });
    expect(parseKeepUntil('3d', NOW)).toEqual({ ok: true, until: NOW + 3 * DAY });
    expect(parseKeepUntil('90m', NOW)).toEqual({ ok: true, until: NOW + 90 * MIN });
    expect(parseKeepUntil('2026-11-17T10:00:00+11:00', NOW)).toEqual({ ok: true, until: Date.parse('2026-11-16T23:00:00Z') });
  });

  it('refuses a past time, more than 30 days, a zoneless time and words', () => {
    expect(parseKeepUntil('2026-11-15T00:00:00Z', NOW)).toEqual({ ok: false, error: 'until must be in the future' });
    expect(parseKeepUntil('31d', NOW).ok).toBe(false);
    expect(parseKeepUntil('2026-11-17T10:00:00', NOW).ok).toBe(false);
    expect(parseKeepUntil('tomorrow', NOW).ok).toBe(false);
  });

  it('needs a one-line reason of 1-200 characters, and only reason and until', () => {
    expect(checkKeepInput({ reason: 'waits for the owner' }, NOW)).toEqual({ ok: true, keep: { until: null, reason: 'waits for the owner', at: NOW } });
    expect(checkKeepInput({ reason: 'x', until: '2h' }, NOW)).toEqual({ ok: true, keep: { until: NOW + 2 * HOUR, reason: 'x', at: NOW } });
    expect(checkKeepInput(null, NOW)).toEqual({ ok: true, keep: null });
    expect(checkKeepInput({ until: '2h' }, NOW).ok).toBe(false);
    expect(checkKeepInput({ reason: '   ' }, NOW).ok).toBe(false);
    expect(checkKeepInput({ reason: 'a'.repeat(201) }, NOW).ok).toBe(false);
    expect(checkKeepInput({ reason: 'two\nlines' }, NOW).ok).toBe(false);
    expect(checkKeepInput({ reason: 'x', by: 'me' }, NOW)).toEqual({ ok: false, error: 'keep supports only reason and until, got by' });
    expect(checkKeepInput('x', NOW).ok).toBe(false);
  });
});

describe('judgeActivity: dormant is an eligible state and no sign of life for N hours', () => {
  const pane: IDormantPane = { cwd: '/work/w1', sessionCreatedAt: NOW - 30 * HOUR };
  const judge = (status: IDormantStatusFacts, over: { tab?: ITab; ledger?: number | null; ledgerFails?: boolean; pane?: typeof pane } = {}) =>
    judgeActivity({
      tab: over.tab ?? tab(),
      status,
      pane: over.pane ?? pane,
      ledgerAt: over.ledgerFails ? { ok: false, error: 'SQLITE_BUSY' } : { ok: true, value: over.ledger ?? null },
    }, 6, NOW);

  it.each(['busy', 'needs-input', 'startup-prompt', 'unknown', 'cancelled'] as const)('never judges a %s tab dormant', (cliState) => {
    expect(judge(statusFacts({ cliState, lastEventAt: NOW - 30 * HOUR })).kind).toBe('active');
  });

  it.each(['idle', 'ready-for-review', 'inactive'] as const)('judges an old %s tab dormant', (cliState) => {
    expect(judge(statusFacts({ cliState }))).toMatchObject({ kind: 'dormant', holds: [] });
  });

  it('takes the newest source: a recent ledger turn keeps the tab active', () => {
    expect(judge(statusFacts(), { ledger: NOW - 2 * HOUR })).toEqual({ kind: 'active', reason: 'activity 120 min ago (turn ledger)' });
  });

  it('counts the transcript, background activity, tab events, restart and keep mark', () => {
    expect(judge(statusFacts({ snapshot: { read: 'ok', lastEntryTs: NOW - HOUR, backgroundActivityAt: null, openBackgroundTasks: 0, transcriptRead: true } })).kind).toBe('active');
    expect(judge(statusFacts({ snapshot: { read: 'ok', lastEntryTs: null, backgroundActivityAt: NOW - HOUR, openBackgroundTasks: 0, transcriptRead: true } })).kind).toBe('active');
    expect(judge(statusFacts({ lastDeliveredAt: { ok: true, value: NOW - HOUR } })).kind).toBe('active');
    expect(judge(statusFacts(), { tab: tab({ lastRestartAt: NOW - HOUR }) }).kind).toBe('active');
    expect(judge(statusFacts(), { tab: tab({ keep: { until: NOW - MIN, reason: 'x', at: NOW - HOUR } }) }).kind).toBe('active');
  });

  it('names the source and time of the last activity', () => {
    expect(judge(statusFacts({ lastEventAt: NOW - 7 * HOUR }))).toEqual({ kind: 'dormant', lastActivityAt: NOW - 7 * HOUR, source: 'last hook event', holds: [] });
  });

  it('holds on an unreadable ledger, transcript or tab-event log', () => {
    expect(judge(statusFacts(), { ledgerFails: true })).toMatchObject({ kind: 'dormant', holds: ['ledger-unreadable'] });
    expect(judge(statusFacts({ snapshot: { read: 'failed', error: 'EACCES' } }))).toMatchObject({ holds: ['transcript-unreadable'] });
    expect(judge(statusFacts({ lastDeliveredAt: { ok: false, error: 'locked' } }))).toMatchObject({ holds: ['tab-events-unreadable'] });
  });

  it('holds when no source has a timestamp', () => {
    const bare = statusFacts({ lastEventAt: null, lastResumeOrStartedAt: null, snapshot: { read: 'none' } });
    expect(judge(bare, { pane: { cwd: null, sessionCreatedAt: null } })).toEqual({ kind: 'dormant', lastActivityAt: null, source: null, holds: ['activity-unknown'] });
  });

  it('reads a closing tab as active, never dormant', () => {
    expect(judge(statusFacts({ retired: true })).kind).toBe('active');
  });
});

describe('holdsOf: each hold keeps a dormant tab open (ADR-0048 §5)', () => {
  it('finds nothing on a bare dormant tab', () => {
    expect(holdsOf(holdInput(), NOW)).toEqual([]);
  });

  it('exempts the workspace orchestrator', () => {
    expect(holdsOf(holdInput({ candidate: { ...holdInput().candidate, isOrchestrator: true } }), NOW)).toEqual(['orchestrator']);
  });

  it('holds an unexpired keep and names it; an expired keep holds nothing', () => {
    const withKeep = (keep: ITab['keep']) => holdsOf(holdInput({ candidate: { ...holdInput().candidate, tab: tab({ keep }) } }), NOW);
    expect(withKeep({ until: NOW + HOUR, reason: 'owner review', at: NOW - DAY })).toEqual(['keep until 2026-11-16T01:00:00.000Z: owner review']);
    expect(withKeep({ until: null, reason: 'lead seat', at: NOW - DAY })).toEqual(['keep (no expiry): lead seat']);
    expect(withKeep({ until: NOW - 1, reason: 'old', at: NOW - DAY })).toEqual([]);
  });

  it('holds a pending orchestration launch or turn', () => {
    const activity = { sessionName: 's-w1', runtimeGeneration: 'g1', turn: { generation: 't1', runtimeGeneration: 'g1', at: NOW } };
    expect(holdsOf(holdInput({ candidate: { ...holdInput().candidate, tab: tab({ orchestrationActivity: activity }) } }), NOW)).toEqual(['orchestration-pending']);
  });

  it('holds a restart, a usage-limit halt, a seat in rotation and a running lifecycle step', () => {
    expect(holdsOf(holdInput({ status: statusFacts({ restarting: true }) }), NOW)).toEqual(['restarting']);
    expect(holdsOf(holdInput({ status: statusFacts({ halted: true }) }), NOW)).toEqual(['usage-limit-halt']);
    for (const seatPhase of ['rotate-requested', 'handoff-ready', 'rotating', 'rotation-alarm'] as const) {
      expect(holdsOf(holdInput({ status: statusFacts({ seatPhase }) }), NOW)).toEqual([`seat-rotation (${seatPhase})`]);
    }
    expect(holdsOf(holdInput({ status: statusFacts({ seatPhase: 'watching' }) }), NOW)).toEqual([]);
    expect(holdsOf(holdInput({ status: statusFacts({ seatPhase: 'watching', seatAdvancing: true }) }), NOW)).toEqual(['seat-rotation (watching)']);
  });

  it('holds a tab whose current turn ended on NEEDS-DECISION or BLOCKED', () => {
    expect(holdsOf(holdInput({ status: statusFacts({ waitingMarker: 'NEEDS-DECISION' }) }), NOW)).toEqual(['needs-decision']);
    expect(holdsOf(holdInput({ status: statusFacts({ waitingMarker: 'BLOCKED' }) }), NOW)).toEqual(['blocked']);
  });

  it('holds an open turn and held digest events, and an unreadable event log', () => {
    expect(holdsOf(holdInput({ status: statusFacts({ turnOpen: true }) }), NOW)).toEqual(['turn-open']);
    expect(holdsOf(holdInput({ status: statusFacts({ heldDigests: { ok: true, value: 2 } }) }), NOW)).toEqual(['tab-events-held (2)']);
    expect(holdsOf(holdInput({ status: statusFacts({ heldDigests: { ok: false, error: 'x' } }) }), NOW)).toEqual(['tab-events-unreadable']);
  });

  it('holds open background tasks; an unread Claude background ledger holds, another provider does not', () => {
    const snap = (snapshot: IDormantStatusFacts['snapshot'], providerId = 'claude') => holdsOf(holdInput({ status: statusFacts({ snapshot, providerId }) }), NOW);
    expect(snap({ read: 'ok', lastEntryTs: null, backgroundActivityAt: null, openBackgroundTasks: 3, transcriptRead: true })).toEqual(['background-tasks (3)']);
    expect(snap({ read: 'ok', lastEntryTs: null, backgroundActivityAt: null, openBackgroundTasks: null, transcriptRead: true })).toEqual(['background-unreadable']);
    expect(snap({ read: 'ok', lastEntryTs: null, backgroundActivityAt: null, openBackgroundTasks: 0, transcriptRead: false })).toEqual(['background-unreadable']);
    expect(snap({ read: 'failed', error: 'x' })).toEqual(['background-unreadable']);
    expect(snap({ read: 'none' })).toEqual(['background-unreadable']);
    expect(snap({ read: 'none' }, 'codex')).toEqual([]);
  });

  it('holds a lease the tab holds, by name; another tab\'s lease holds nothing', () => {
    const lease = (tabId: string, name: string) => ({
      name, kind: 'merge', resource: 'x/y', epic: null, note: null, acquiredAt: '', renewedAt: '', ttlSeconds: null, expiresAt: null, survivesTab: false,
      holder: { workspaceId: 'ws-a', tabId, tabName: null, verified: true, admin: false },
    });
    const pass = { ...emptyPass(), leases: { ok: true as const, value: [lease('tab-w1', 'merge:x/y'), lease('tab-other', 'epic:z')] } };
    expect(holdsOf(holdInput({ pass }), NOW)).toEqual(['lease merge:x/y']);
  });

  it('holds live bg jobs, armed watches, queued or held inbox lines, open notes routed to it', () => {
    expect(holdsOf(holdInput({ jobs: { ok: true, value: 1 } }), NOW)).toEqual(['bg-jobs (1)']);
    const watch = { id: 'w-1', workspaceId: 'ws-a', tabId: 'tab-w1' } as never;
    expect(holdsOf(holdInput({ pass: { ...emptyPass(), watches: { ok: true, value: [watch] } } }), NOW)).toEqual(['watches (1)']);
    const item = (state: string) => ({ id: `i-${state}`, targetWorkspaceId: 'ws-a', targetTabId: 'tab-w1', state }) as never;
    expect(holdsOf(holdInput({ pass: { ...emptyPass(), inbox: { ok: true, value: [item('queued'), item('held'), item('delivered'), item('dropped')] } } }), NOW)).toEqual(['inbox (2)']);
    const note = (state: string, tabId: string) => ({ id: `n-${state}`, state, deliveredTo: { workspaceId: 'ws-a', tabId } }) as never;
    expect(holdsOf(holdInput({ pass: { ...emptyPass(), notes: { ok: true, value: [note('delivered', 'tab-w1'), note('acked', 'tab-w1'), note('queued', 'tab-x')] } } }), NOW)).toEqual(['notes (1)']);
  });

  it('holds an open Mission Control item or run of the tab, an active grant, and a reportsTo target', () => {
    const workspace = { ...emptyWorkspace(), missionWork: { ok: true as const, value: new Map([['tab-w1', ['nd-abc', 'run-1']]]) } };
    expect(holdsOf(holdInput({ workspace }), NOW)).toEqual(['mission-control nd-abc, run-1']);
    const grant = (over: object) => ({ id: 'g-1', grantee: { workspaceId: 'ws-a', tabId: 'tab-w1' }, revokedAt: null, expiresAt: NOW + HOUR, ...over }) as never;
    expect(holdsOf(holdInput({ pass: { ...emptyPass(), grants: { ok: true, value: [grant({})] } } }), NOW)).toEqual(['grant g-1']);
    expect(holdsOf(holdInput({ pass: { ...emptyPass(), grants: { ok: true, value: [grant({ revokedAt: NOW - 1 }), grant({ expiresAt: NOW - 1 })] } } }), NOW)).toEqual([]);
    expect(holdsOf(holdInput({ candidate: { ...holdInput().candidate, reportsTarget: true } }), NOW)).toEqual(['reports-target']);
  });

  it('holds on every store that cannot be read', () => {
    const failed = { ok: false as const, error: 'unreadable' };
    const pass: IDormantPassReads = { leases: failed, watches: failed, inbox: failed, notes: failed, grants: failed };
    expect(holdsOf(holdInput({ pass, jobs: failed, workspace: { ...emptyWorkspace(), missionWork: failed } }), NOW)).toEqual([
      'leases-unreadable', 'jobs-unreadable', 'watches-unreadable', 'inbox-unreadable', 'notes-unreadable', 'mission-control-unreadable', 'grants-unreadable',
    ]);
  });
});

describe('worktreeVerdict: uncommitted changes in the tab\'s cwd hold it (ADR-0048 §6)', () => {
  const git = (over: Partial<IGitFacts>): { ok: true; value: IGitFacts } => ({
    ok: true,
    value: { kind: 'ok', cwd: '/w', worktree: '/w', branch: 'feat/x', head: 'abc', baseRef: null, base: null, dirty: 0, ...over },
  });

  it('passes a clean worktree, a directory outside git and a gone directory', () => {
    expect(worktreeVerdict('/w', git({}))).toEqual({ hold: null, answer: '/w: clean on feat/x' });
    expect(worktreeVerdict('/w', git({ kind: 'no-repo', worktree: null, dirty: null }))).toEqual({ hold: null, answer: '/w: not a git repository' });
    expect(worktreeVerdict('/w', git({ kind: 'no-cwd', worktree: null, dirty: null }))).toEqual({ hold: null, answer: '/w: directory gone' });
  });

  it('holds a dirty worktree, an unknown cwd, a failed status and a failed read', () => {
    expect(worktreeVerdict('/w', git({ dirty: 3 })).hold).toBe('worktree-dirty (3)');
    expect(worktreeVerdict(null, git({})).hold).toBe('cwd-unknown');
    expect(worktreeVerdict('/w', git({ dirty: null })).hold).toBe('worktree-unreadable');
    expect(worktreeVerdict('/w', { ok: false, error: 'ssh: timeout' })).toEqual({ hold: 'worktree-unreadable', answer: 'git read failed: ssh: timeout' });
  });
});
