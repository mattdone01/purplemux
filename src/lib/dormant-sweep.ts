import type { IGitFacts } from '@/types/rotation-checkpoint';
import type { IDormantStatusFacts, TDormantMode, TDormantRead } from '@/types/dormant';
import type { IGrant } from '@/types/grant';
import type { IInboxItem } from '@/types/inbox';
import type { ILease } from '@/types/lease';
import type { INote } from '@/types/note';
import type { ITab, ITabKeep, TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';
import type { IWatch } from '@/types/watch';

// The dormant-tab sweep (ADR-0048). An agent tab that ran no turn for `tabs.dormant.hours` and sits at its prompt
// (or with its agent exited) is dormant. A dormant tab that holds nothing is closed in `close` mode and reported as
// `would-close` in `report` mode; a dormant tab that holds anything is reported, never closed. Every read that fails
// is a hold: a wrong close loses a worker's context, a missed one costs one more idle tab.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DORMANT_MODE_KEY = 'tabs.dormant.mode';
export const DORMANT_HOURS_KEY = 'tabs.dormant.hours';
/** The per-workspace override of the fleet mode (the tab-cap pattern): `tabs.dormant.mode.<workspaceId>`. */
export const workspaceDormantModeKey = (workspaceId: string): string => `${DORMANT_MODE_KEY}.${workspaceId}`;
export const DEFAULT_DORMANT_MODE: TDormantMode = 'report';
export const DEFAULT_DORMANT_HOURS = 6;
export const DORMANT_HOURS_MIN = 1;
export const DORMANT_HOURS_MAX = 168;
export const DORMANT_TICK_MS = 10 * MIN;
/** At most this many closes in one pass, fleet-wide, oldest activity first. */
export const DORMANT_CLOSES_PER_PASS = 5;
/** One report line per tab per kind in this window. */
export const DORMANT_REPORT_EVERY_MS = DAY;
export const KEEP_MAX_MS = 30 * DAY;
export const KEEP_REASON_MAX = 200;

const MODES: readonly TDormantMode[] = ['off', 'report', 'close'];
/** The states a dormant tab can be in: at its prompt, or its agent process gone. Busy (WAITING too) never is. */
export const DORMANT_STATES: ReadonlySet<TCliState> = new Set<TCliState>(['idle', 'ready-for-review', 'inactive']);
const ROTATION_PHASES = new Set(['rotate-requested', 'handoff-ready', 'rotating', 'rotation-alarm']);
const AGENT_PANELS: ReadonlySet<TPanelType> = new Set<TPanelType>(['claude-code', 'codex-cli', 'grok-cli']);

export type TConfigSource = 'workspace-config' | 'fleet-config' | 'default' | 'default-invalid' | 'default-unreadable';

export interface IDormantPolicy {
  mode: TDormantMode;
  hours: number;
  modeSource: TConfigSource;
  hoursSource: TConfigSource;
  /** Why a stored value was not used. */
  reasons: string[];
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const parseDormantMode = (raw: string | null, key: string = DORMANT_MODE_KEY): { mode: TDormantMode | null; reason: string | null } => {
  if (raw === null) return { mode: null, reason: null };
  const text = raw.trim();
  return (MODES as readonly string[]).includes(text)
    ? { mode: text as TDormantMode, reason: null }
    : { mode: null, reason: `${key} is ${JSON.stringify(raw)}, not one of ${MODES.join(' | ')}` };
};

export const parseDormantHours = (raw: string | null): { hours: number | null; reason: string | null } => {
  if (raw === null) return { hours: null, reason: null };
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return { hours: null, reason: `${DORMANT_HOURS_KEY} is ${JSON.stringify(raw)}, not a number of hours` };
  const hours = Number(text);
  if (hours < DORMANT_HOURS_MIN || hours > DORMANT_HOURS_MAX) {
    return { hours: null, reason: `${DORMANT_HOURS_KEY} is ${hours}, outside ${DORMANT_HOURS_MIN}..${DORMANT_HOURS_MAX}` };
  }
  return { hours, reason: null };
};

/**
 * The workspace's policy. Its own mode key wins over the fleet key. An invalid or unreadable mode, at either key, is
 * the default (`report`) and never falls through to the other key, so a broken value never closes a tab. An invalid
 * hours value is the default 6; an unreadable one also holds the mode at `report`.
 */
export const readDormantPolicy = async (config: (key: string) => Promise<string | null>, workspaceId: string): Promise<IDormantPolicy> => {
  const reasons: string[] = [];
  const read = async (key: string): Promise<{ value: string | null } | { failed: true }> => {
    try {
      return { value: await config(key) };
    } catch (err) {
      reasons.push(`${key} unreadable: ${errorText(err)}`);
      return { failed: true };
    }
  };
  const modeAt = async (key: string, source: TConfigSource): Promise<{ mode: TDormantMode; source: TConfigSource } | null> => {
    const got = await read(key);
    if ('failed' in got) return { mode: DEFAULT_DORMANT_MODE, source: 'default-unreadable' };
    const parsed = parseDormantMode(got.value, key);
    if (parsed.mode) return { mode: parsed.mode, source };
    if (parsed.reason) {
      reasons.push(parsed.reason);
      return { mode: DEFAULT_DORMANT_MODE, source: 'default-invalid' };
    }
    return null;
  };
  const chosen = (await modeAt(workspaceDormantModeKey(workspaceId), 'workspace-config'))
    ?? (await modeAt(DORMANT_MODE_KEY, 'fleet-config'))
    ?? { mode: DEFAULT_DORMANT_MODE, source: 'default' as TConfigSource };
  let { mode, source: modeSource } = chosen;
  const hoursRead = await read(DORMANT_HOURS_KEY);
  let hours = DEFAULT_DORMANT_HOURS;
  let hoursSource: TConfigSource = 'default';
  if ('failed' in hoursRead) {
    hoursSource = 'default-unreadable';
    if (mode === 'close') {
      mode = DEFAULT_DORMANT_MODE;
      modeSource = 'default-unreadable';
    }
  } else {
    const parsed = parseDormantHours(hoursRead.value);
    if (parsed.hours !== null) {
      hours = parsed.hours;
      hoursSource = 'fleet-config';
    } else if (parsed.reason) {
      reasons.push(parsed.reason);
      hoursSource = 'default-invalid';
    }
  }
  return { mode, hours, modeSource, hoursSource, reasons };
};

// ─── the keep mark ────────────────────────────────────────────────────────

export type TKeepCheck = { ok: true; keep: ITabKeep | null } | { ok: false; error: string };

/** `--until`: an ISO time, or `<n>m`, `<n>h`, `<n>d` from now. At most 30 days ahead, and in the future. */
export const parseKeepUntil = (raw: unknown, now: number): { ok: true; until: number } | { ok: false; error: string } => {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'until must be an ISO time or a duration such as 12h or 3d' };
  const text = raw.trim();
  const duration = /^(\d{1,5})([mhd])$/.exec(text);
  let until: number;
  if (duration) {
    const unit = duration[2] === 'm' ? MIN : duration[2] === 'h' ? HOUR : DAY;
    until = now + Number(duration[1]) * unit;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    until = Date.parse(text);
    if (!Number.isFinite(until)) return { ok: false, error: `until ${JSON.stringify(text)} is not a valid time` };
  } else {
    return { ok: false, error: `until ${JSON.stringify(text)} is neither an ISO time with a zone nor a duration such as 12h or 3d` };
  }
  if (until <= now) return { ok: false, error: 'until must be in the future' };
  if (until - now > KEEP_MAX_MS) return { ok: false, error: `until is more than ${KEEP_MAX_MS / DAY} days ahead; omit it for a keep with no expiry` };
  return { ok: true, until };
};

/** The PATCH body's `keep`: `null` clears it; otherwise `{ reason, until? }`. */
export const checkKeepInput = (raw: unknown, now: number): TKeepCheck => {
  if (raw === null) return { ok: true, keep: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'keep must be an object { reason, until? } or null' };
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => key !== 'reason' && key !== 'until');
  if (unknown.length) return { ok: false, error: `keep supports only reason and until, got ${unknown.join(', ')}` };
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return { ok: false, error: 'keep needs a reason (1-200 characters)' };
  if ([...reason].length > KEEP_REASON_MAX) return { ok: false, error: `keep reason is longer than ${KEEP_REASON_MAX} characters` };
  if (/[\p{C}\p{Zl}\p{Zp}]/u.test(reason)) return { ok: false, error: 'keep reason must be one line of printable text' };
  if (body.until === undefined || body.until === null) return { ok: true, keep: { until: null, reason, at: now } };
  const until = parseKeepUntil(body.until, now);
  if (!until.ok) return until;
  return { ok: true, keep: { until: until.until, reason, at: now } };
};

export const keepHolds = (keep: ITabKeep | undefined, now: number): boolean =>
  !!keep && (keep.until === null || keep.until > now);

// ─── the judgement ────────────────────────────────────────────────────────

export interface IDormantCandidate {
  workspaceId: string;
  paneId: string;
  tab: ITab;
  isOrchestrator: boolean;
  /** Another tab of the layout names this one as its `reportsTo`. */
  reportsTarget: boolean;
}

/** The pane's live working directory and the tmux session's creation time (ms); null fields when unknown. */
export interface IDormantPane {
  cwd: string | null;
  sessionCreatedAt: number | null;
}

export type TActivityJudgement =
  | { kind: 'active'; reason: string }
  | { kind: 'dormant'; lastActivityAt: number | null; source: string | null; holds: string[] };

/**
 * Whether the tab is dormant: an eligible state and no sign of life for `hours`. The newest of every source that
 * read is its last activity. An unreadable source, or no timestamp at all, is a hold on a dormant tab.
 */
export const judgeActivity = (
  input: { tab: ITab; status: IDormantStatusFacts; pane: IDormantPane; ledgerAt: TDormantRead<number | null> },
  hours: number,
  now: number,
): TActivityJudgement => {
  const { tab, status, pane, ledgerAt } = input;
  if (!DORMANT_STATES.has(status.cliState)) return { kind: 'active', reason: `state ${status.cliState}` };
  if (status.retired) return { kind: 'active', reason: 'closing' };
  const holds: string[] = [];
  const sources: Array<[string, number | null | undefined]> = [
    ['last hook event', status.lastEventAt],
    ['busy since', status.busySince],
    ['agent launch', status.lastResumeOrStartedAt],
    ['tab restart', tab.lastRestartAt],
    ['last stop record', tab.watchdogTurnEnd?.at],
    ['keep mark', tab.keep?.at],
    ['session created', pane.sessionCreatedAt],
  ];
  if (ledgerAt.ok) sources.push(['turn ledger', ledgerAt.value]);
  else holds.push('ledger-unreadable');
  if (status.snapshot.read === 'ok') {
    sources.push(['transcript', status.snapshot.lastEntryTs], ['background activity', status.snapshot.backgroundActivityAt]);
  } else if (status.snapshot.read === 'failed') holds.push('transcript-unreadable');
  if (status.lastDeliveredAt.ok) sources.push(['tab event delivery', status.lastDeliveredAt.value]);
  else holds.push('tab-events-unreadable');
  let lastActivityAt: number | null = null;
  let source: string | null = null;
  for (const [name, at] of sources) {
    if (typeof at === 'number' && Number.isFinite(at) && (lastActivityAt === null || at > lastActivityAt)) {
      lastActivityAt = at;
      source = name;
    }
  }
  if (lastActivityAt !== null && now - lastActivityAt < hours * HOUR) {
    return { kind: 'active', reason: `activity ${Math.round((now - lastActivityAt) / MIN)} min ago (${source})` };
  }
  if (lastActivityAt === null) holds.push('activity-unknown');
  return { kind: 'dormant', lastActivityAt, source, holds };
};

/** Reads made once per pass and shared by every tab. */
export interface IDormantPassReads {
  leases: TDormantRead<ILease[]>;
  watches: TDormantRead<IWatch[]>;
  inbox: TDormantRead<IInboxItem[]>;
  notes: TDormantRead<INote[]>;
  grants: TDormantRead<IGrant[]>;
}

/** Reads made once per workspace per pass. */
export interface IDormantWorkspaceReads {
  ledger: TDormantRead<Map<string, number>>;
  missionWork: TDormantRead<Map<string, string[]>>;
}

export interface IDormantHoldInput {
  candidate: IDormantCandidate;
  status: IDormantStatusFacts;
  pass: IDormantPassReads;
  workspace: IDormantWorkspaceReads;
  /** Live registered `tab bg` jobs that still hold work. */
  jobs: TDormantRead<number>;
}

const OPEN_NOTE_STATES = new Set(['queued', 'delivered', 'undeliverable']);

/** Every hold except the worktree's, which costs a git read (over ssh for a remote tab) and runs last. */
export const holdsOf = (input: IDormantHoldInput, now: number): string[] => {
  const { candidate, status, pass, workspace, jobs } = input;
  const { tab, workspaceId } = candidate;
  const tabId = tab.id;
  const holds: string[] = [];
  const mine = <T>(read: TDormantRead<T[]>, name: string, pick: (row: T) => boolean, label: (rows: T[]) => string): void => {
    if (!read.ok) {
      holds.push(`${name}-unreadable`);
      return;
    }
    const rows = read.value.filter(pick);
    if (rows.length) holds.push(label(rows));
  };
  if (candidate.isOrchestrator) holds.push('orchestrator');
  if (keepHolds(tab.keep, now)) {
    holds.push(tab.keep!.until === null ? `keep (no expiry): ${tab.keep!.reason}` : `keep until ${new Date(tab.keep!.until).toISOString()}: ${tab.keep!.reason}`);
  }
  if (tab.orchestrationActivity?.launch || tab.orchestrationActivity?.turn) holds.push('orchestration-pending');
  if (status.restarting) holds.push('restarting');
  if (status.halted) holds.push('usage-limit-halt');
  if (status.seatAdvancing || (status.seatPhase && ROTATION_PHASES.has(status.seatPhase))) {
    holds.push(`seat-rotation (${status.seatPhase ?? 'step running'})`);
  }
  if (status.waitingMarker === 'NEEDS-DECISION') holds.push('needs-decision');
  if (status.waitingMarker === 'BLOCKED') holds.push('blocked');
  if (status.turnOpen) holds.push('turn-open');
  if (!status.heldDigests.ok) holds.push('tab-events-unreadable');
  else if (status.heldDigests.value > 0) holds.push(`tab-events-held (${status.heldDigests.value})`);
  const snapshot = status.snapshot;
  if (snapshot.read === 'ok' && snapshot.openBackgroundTasks !== null && snapshot.openBackgroundTasks > 0) {
    holds.push(`background-tasks (${snapshot.openBackgroundTasks})`);
  } else if (status.providerId === 'claude'
    && (snapshot.read !== 'ok' || snapshot.transcriptRead === false || snapshot.openBackgroundTasks === null)) {
    holds.push('background-unreadable');
  }
  mine(pass.leases, 'leases', (l) => l.holder.workspaceId === workspaceId && l.holder.tabId === tabId,
    (rows) => `lease ${rows.map((l) => l.name).join(', ')}`);
  if (!jobs.ok) holds.push('jobs-unreadable');
  else if (jobs.value > 0) holds.push(`bg-jobs (${jobs.value})`);
  mine(pass.watches, 'watches', (w) => w.workspaceId === workspaceId && w.tabId === tabId, (rows) => `watches (${rows.length})`);
  mine(pass.inbox, 'inbox', (i) => i.targetWorkspaceId === workspaceId && i.targetTabId === tabId && (i.state === 'queued' || i.state === 'held'),
    (rows) => `inbox (${rows.length})`);
  mine(pass.notes, 'notes', (n) => OPEN_NOTE_STATES.has(n.state) && n.deliveredTo !== null
    && n.deliveredTo.workspaceId === workspaceId && n.deliveredTo.tabId === tabId, (rows) => `notes (${rows.length})`);
  if (!workspace.missionWork.ok) holds.push('mission-control-unreadable');
  else {
    const ids = workspace.missionWork.value.get(tabId);
    if (ids?.length) holds.push(`mission-control ${ids.join(', ')}`);
  }
  mine(pass.grants, 'grants', (g) => g.revokedAt === null && g.expiresAt > now
    && g.grantee.workspaceId === workspaceId && g.grantee.tabId === tabId, (rows) => `grant ${rows.map((g) => g.id).join(', ')}`);
  if (candidate.reportsTarget) holds.push('reports-target');
  return holds;
};

/** The worktree hold from the git probe (`seat-host-io` gitFacts), and the answer to name in the note. */
export const worktreeVerdict = (
  cwd: string | null,
  facts: TDormantRead<IGitFacts>,
): { hold: string | null; answer: string } => {
  if (cwd === null) return { hold: 'cwd-unknown', answer: 'cwd unknown' };
  if (!facts.ok) return { hold: 'worktree-unreadable', answer: `git read failed: ${facts.error}` };
  const git = facts.value;
  if (git.kind === 'no-repo') return { hold: null, answer: `${cwd}: not a git repository` };
  if (git.kind === 'no-cwd') return { hold: null, answer: `${cwd}: directory gone` };
  if (git.dirty === null) return { hold: 'worktree-unreadable', answer: `${git.worktree ?? cwd}: git status failed` };
  if (git.dirty > 0) return { hold: `worktree-dirty (${git.dirty})`, answer: `${git.worktree ?? cwd}: ${git.dirty} uncommitted` };
  return { hold: null, answer: `${git.worktree ?? cwd}: clean${git.branch ? ` on ${git.branch}` : ''}` };
};

export const isAgentPanel = (panelType: TPanelType | undefined): boolean => !!panelType && AGENT_PANELS.has(panelType);

/** The checks every close passed, named in its note and audit entry. */
export const CLOSE_CHECKS = [
  'orchestrator', 'keep', 'orchestration', 'restart', 'usage limit', 'seat rotation', 'end marker', 'open turn',
  'held tab events', 'background tasks', 'leases', 'bg jobs', 'watches', 'inbox', 'notes', 'Mission Control', 'grants',
  'reports-to', 'worktree',
] as const;
