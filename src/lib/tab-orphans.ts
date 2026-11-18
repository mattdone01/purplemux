import fs from 'fs/promises';
import { agentProviderOf } from '@/lib/process-utils';
import { parentPid, terminateProcesses, type ITabReaperDeps } from '@/lib/tab-reaper';

// The orphan sweep: what a close or a restart cannot reach because nothing attributes it to a tab, or because the
// tab it names is gone. Four kinds, per host:
//   unowned-tab      a process whose PMUX_TAB_ID names a tab in no layout of this server;
//   duplicate-agent  an agent whose PMUX_TAB_ID names a layout tab, outside that tab's current pane tree;
//   unowned-session  a tmux session on this server's socket that no layout owns;
//   unmarked-agent   an agent with no PMUX_TAB_ID that carries this server's PMUX_URL or runs under its tmux server.
// A marked process counts only when this server started it (its PMUX_URL, its tmux socket in TMUX, or its tmux
// server above it): another purplemux on the same host and account has its own tabs, and they are never ours.
// An unmarked process's environment is read for key presence only, and for whether PMUX_URL names this server:
// no other value is kept. No argv leaves the scan; it is read only to recognise an agent.

export type TOrphanKind = 'unowned-tab' | 'duplicate-agent' | 'unowned-session' | 'unmarked-agent';

/** A process too young to be judged: a tab's session exists a moment before its tab reaches the layout. */
export const ORPHAN_MIN_AGE_MS = 60_000;

/** What one scan reads of a process. */
export interface IOrphanProcessFact {
  pid: number;
  ppid: number;
  comm: string;
  ageMs: number;
  cwd: string | null;
  /** The process start time (/proc/<pid>/stat field 22): its identity for a later signal. */
  start: string;
  /** The PMUX_TAB_ID value; null when the key is absent; `?` when the value is no tab id. */
  tabId: string | null;
  /** PMUX_URL names this server. */
  urlMatch: boolean;
  /** A marked process only: TMUX names this server's tmux socket. */
  socketMatch: boolean;
  /** A descendant of this server's tmux server. */
  underServer: boolean;
  /** The session whose pane tree holds the process; null when no live pane holds it. */
  heldBy: string | null;
  agent: boolean;
}

export interface IOrphanSessionFact {
  name: string;
  ageMs: number;
}

export interface IOrphanHostFacts {
  sessions: IOrphanSessionFact[];
  processes: IOrphanProcessFact[];
}

export interface IOwnedTab {
  workspaceId: string;
  sessionName: string;
  /** The remote host; null for a local tab. */
  host: string | null;
}

export interface IOrphanOwnership {
  tabs: ReadonlyMap<string, IOwnedTab>;
  /** Pids registered as background jobs on the host being judged: a tab's own job, never a duplicate. */
  registeredPids?: ReadonlySet<number>;
}

export type IOrphanEntry =
  | { kind: 'unowned-tab' | 'duplicate-agent' | 'unmarked-agent'; process: IOrphanProcessFact; workspaceId?: string }
  | { kind: 'unowned-session'; session: IOrphanSessionFact };

const TAB_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/** C0, DEL, C1 and the Unicode line separators out: one entry is one line, whatever the kernel holds. */
const printable = (text: string): string =>
  Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? ' ' : ch;
  }).join('');

export interface IEnvironMarks {
  tabId: string | null;
  urlMatch: boolean;
  socketMatch: boolean;
}

/**
 * The marks the sweep reads from one environment. PMUX_TAB_ID's value is kept, sanitised; PMUX_URL is compared and
 * dropped; TMUX is compared only for a marked process. Nothing else is read.
 */
export const readEnvironMarks = (environ: Buffer, urls: readonly string[], socketPath: string | null): IEnvironMarks => {
  const wantedUrls = new Set(urls.map((url) => `PMUX_URL=${url}`));
  let tabId: string | null = null;
  let urlMatch = false;
  let tmux: string | null = null;
  for (const entry of environ.toString('utf-8').split('\0')) {
    if (entry.startsWith('PMUX_TAB_ID=')) {
      const value = entry.slice('PMUX_TAB_ID='.length);
      tabId = TAB_ID.test(value) ? value : '?';
    } else if (wantedUrls.has(entry)) urlMatch = true;
    else if (entry.startsWith('TMUX=')) tmux = entry;
  }
  const socketMatch = tabId !== null && !!socketPath && !!tmux?.startsWith(`TMUX=${socketPath},`);
  return { tabId, urlMatch, socketMatch };
};

const isAttributable = (p: IOrphanProcessFact): boolean => p.urlMatch || p.socketMatch || p.underServer;

/** Unmarked agents this server can be said to have started: the input of kind (iv) and of the liveness guard. */
export const unmarkedAgents = (facts: IOrphanHostFacts): IOrphanProcessFact[] =>
  facts.processes.filter((p) => p.tabId === null && p.agent && (p.urlMatch || p.underServer));

/** The four lists for one host (`null`: this server's own host). */
export const classifyOrphans = (host: string | null, facts: IOrphanHostFacts, owned: IOrphanOwnership): IOrphanEntry[] => {
  const ownedSessions = new Set([...owned.tabs.values()].filter((t) => t.host === host).map((t) => t.sessionName));
  const entries: IOrphanEntry[] = [];
  for (const p of facts.processes) {
    if (p.tabId === null || !isAttributable(p)) continue;
    const tab = owned.tabs.get(p.tabId);
    if (!tab) {
      entries.push({ kind: 'unowned-tab', process: p });
      continue;
    }
    const inItsTree = tab.host === host && p.heldBy === tab.sessionName;
    if (p.agent && !inItsTree && !owned.registeredPids?.has(p.pid)) {
      entries.push({ kind: 'duplicate-agent', process: p, workspaceId: tab.workspaceId });
    }
  }
  for (const session of facts.sessions) {
    if (!ownedSessions.has(session.name)) entries.push({ kind: 'unowned-session', session });
  }
  for (const p of unmarkedAgents(facts)) {
    if (p.heldBy !== null && ownedSessions.has(p.heldBy)) continue;
    entries.push({ kind: 'unmarked-agent', process: p });
  }
  return entries;
};

export type TOrphanRefusal = 'not-reapable' | 'held-by-session' | 'too-young' | 'protected' | 'identity-changed' | 'forbidden';

/** Why `--reap` leaves this entry alone, or null. Only kinds (i) and (ii) are ever signalled. */
export const reapRefusal = (entry: IOrphanEntry): TOrphanRefusal | null => {
  if (entry.kind !== 'unowned-tab' && entry.kind !== 'duplicate-agent') return 'not-reapable';
  if (entry.process.heldBy !== null) return 'held-by-session';
  if (entry.process.ageMs < ORPHAN_MIN_AGE_MS) return 'too-young';
  return null;
};

/** One entry as the CLI and the audit see it. An unmarked agent carries pid, ppid, comm, age and cwd only. */
export interface IOrphanView {
  kind: TOrphanKind;
  pid?: number;
  ppid?: number;
  comm?: string;
  ageS: number;
  cwd?: string | null;
  tabId?: string;
  session?: string;
}

export const viewOrphan = (entry: IOrphanEntry): IOrphanView => {
  if (entry.kind === 'unowned-session') {
    return { kind: entry.kind, session: printable(entry.session.name), ageS: Math.floor(entry.session.ageMs / 1000) };
  }
  const p = entry.process;
  const base = { kind: entry.kind, pid: p.pid, ppid: p.ppid, comm: printable(p.comm), ageS: Math.floor(p.ageMs / 1000), cwd: p.cwd === null ? null : printable(p.cwd) };
  if (entry.kind === 'unmarked-agent') return base;
  return { ...base, tabId: p.tabId ?? undefined, ...(p.heldBy ? { session: printable(p.heldBy) } : {}) };
};

export interface IOrphanScanDeps extends ITabReaperDeps {
  parentPid: (pid: number) => Promise<number | null>;
  comm: (pid: number) => Promise<string | null>;
  /** Read only to recognise an agent; never kept. */
  argv: (pid: number) => Promise<string[] | null>;
  cwd: (pid: number) => Promise<string | null>;
  /** Milliseconds since the process started, or null when it is gone. */
  ageMs: (pid: number) => Promise<number | null>;
}

export interface ILocalOrphanScope {
  /** PMUX_URL values that name this server. */
  urls: readonly string[];
  /** This server's tmux socket path. */
  socketPath: string | null;
  tmuxServerPid: number | null;
  panes: ReadonlyArray<{ session: string; panePid: number; ageMs: number }>;
}

const readText = async (file: string): Promise<string | null> => {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return null;
  }
};

/** Linux's USER_HZ: /proc/<pid>/stat counts start time in these ticks on every architecture purplemux runs on. */
const CLOCK_TICKS = 100;

export const defaultOrphanScanDeps = (base: ITabReaperDeps): IOrphanScanDeps => ({
  ...base,
  parentPid,
  comm: async (pid) => (await readText(`/proc/${pid}/comm`))?.trim() ?? null,
  argv: async (pid) => {
    const raw = await readText(`/proc/${pid}/cmdline`);
    return raw === null ? null : raw.split('\0').filter(Boolean);
  },
  cwd: async (pid) => {
    try {
      return await fs.readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  },
  ageMs: async (pid) => {
    const [uptime, start] = await Promise.all([readText('/proc/uptime'), base.startTime(pid)]);
    const up = uptime ? Number(uptime.split(' ')[0]) : NaN;
    const ticks = Number(start);
    if (!Number.isFinite(up) || !Number.isFinite(ticks)) return null;
    return Math.max(0, Math.round(up * 1000 - (ticks * 1000) / CLOCK_TICKS));
  },
});

const MAX_DEPTH = 128;
const SCAN_BATCH = 64;

/**
 * The local host's facts, read from /proc through `deps` (a fake /proc in tests). Null without /proc. The server,
 * its ancestors and descendants and the tmux server are never facts: nothing here may ever be signalled.
 */
export const collectLocalOrphanFacts = async (deps: IOrphanScanDeps, scope: ILocalOrphanScope): Promise<IOrphanHostFacts | null> => {
  if (!(await deps.procAvailable())) return null;
  const excluded = new Set<number>([deps.selfPid, ...(await deps.protectedPids()), ...(await deps.serverDescendants())]);
  if (scope.tmuxServerPid) excluded.add(scope.tmuxServerPid);
  const paneSession = new Map(scope.panes.map((p) => [p.panePid, p.session]));
  const parents = new Map<number, number | null>();
  const parentOf = async (pid: number): Promise<number | null> => {
    if (!parents.has(pid)) parents.set(pid, await deps.parentPid(pid));
    return parents.get(pid)!;
  };
  const holder = async (pid: number): Promise<{ heldBy: string | null; underServer: boolean }> => {
    let heldBy: string | null = null;
    let current: number | null = pid;
    for (let depth = 0; current !== null && current > 1 && depth < MAX_DEPTH; depth += 1) {
      if (current === scope.tmuxServerPid) return { heldBy, underServer: true };
      heldBy ??= paneSession.get(current) ?? null;
      current = await parentOf(current);
    }
    return { heldBy, underServer: false };
  };

  const scanOne = async (pid: number): Promise<IOrphanProcessFact | null> => {
    if (pid <= 1 || excluded.has(pid) || (await deps.ownerUid(pid)) !== deps.uid) return null;
    const environ = await deps.readEnviron(pid);
    if (!environ) return null;
    const marks = readEnvironMarks(environ, scope.urls, scope.socketPath);
    const { heldBy, underServer } = await holder(pid);
    if (marks.tabId === null && !marks.urlMatch && !underServer) return null;
    const [argv, comm] = await Promise.all([deps.argv(pid), deps.comm(pid)]);
    const agent = !!argv && agentProviderOf(argv, comm ?? '') !== null;
    if (marks.tabId === null && !agent) return null;
    const [start, ageMs, cwd, ppid] = await Promise.all([deps.startTime(pid), deps.ageMs(pid), deps.cwd(pid), parentOf(pid)]);
    if (start === null || ageMs === null) return null;
    return { pid, ppid: ppid ?? 0, comm: comm ?? '', ageMs, cwd, start, ...marks, underServer, heldBy, agent };
  };

  const processes: IOrphanProcessFact[] = [];
  const pids = await deps.listPids();
  for (let i = 0; i < pids.length; i += SCAN_BATCH) {
    for (const fact of await Promise.all(pids.slice(i, i + SCAN_BATCH).map(scanOne))) if (fact) processes.push(fact);
  }
  processes.sort((a, b) => a.pid - b.pid);
  const sessions = [...new Map(scope.panes.map((p) => [p.session, { name: p.session, ageMs: p.ageMs }])).values()];
  return { sessions, processes };
};

export interface IOrphanReapTarget {
  entry: Extract<IOrphanEntry, { process: IOrphanProcessFact }>;
}

export interface IOrphanReapOutcome {
  pid: number;
  comm: string;
  tabId: string | null;
  kind: TOrphanKind;
  /** `unknown`: a remote reap whose host stopped answering; a signal may have been sent. */
  outcome: 'killed' | 'survivor' | 'refused' | 'unknown';
  refusal?: TOrphanRefusal;
}

/**
 * Signal the chosen (i)/(ii) entries on this host with the reap's own steps and guards: never pid 0 or 1, the
 * server, its ancestors or descendants, or the tmux server; a pid whose start time changed is a different process.
 */
export const reapLocalOrphans = async (
  deps: ITabReaperDeps,
  targets: readonly IOrphanReapTarget[],
  tmuxServerPid: number | null,
): Promise<IOrphanReapOutcome[]> => {
  const protectedSet = new Set<number>([deps.selfPid, ...(await deps.protectedPids()), ...(await deps.serverDescendants())]);
  if (tmuxServerPid) protectedSet.add(tmuxServerPid);
  const outcomes: IOrphanReapOutcome[] = [];
  const chosen: Array<{ pid: number; comm: string; start: string; target: IOrphanReapTarget }> = [];
  for (const target of targets) {
    const p = target.entry.process;
    const base = { pid: p.pid, comm: printable(p.comm), tabId: p.tabId, kind: target.entry.kind };
    const refusal = reapRefusal(target.entry)
      ?? (p.pid <= 1 || protectedSet.has(p.pid) ? 'protected' : null)
      ?? ((await deps.startTime(p.pid)) !== p.start ? 'identity-changed' : null);
    if (refusal) outcomes.push({ ...base, outcome: 'refused', refusal });
    else chosen.push({ pid: p.pid, comm: p.comm, start: p.start, target });
  }
  if (chosen.length === 0) return outcomes;
  const { survivors } = await terminateProcesses(deps, chosen);
  const left = new Set(survivors);
  for (const { pid, target } of chosen) {
    const p = target.entry.process;
    outcomes.push({ pid, comm: printable(p.comm), tabId: p.tabId, kind: target.entry.kind, outcome: left.has(pid) ? 'survivor' : 'killed' });
  }
  return outcomes;
};

/** The audit line of one signalled orphan: no environ value but the tab id, no argv. */
export const orphanReapAudit = (host: string, outcome: IOrphanReapOutcome): Record<string, unknown> => ({
  event: 'tab-orphan-reap',
  host,
  pid: outcome.pid,
  comm: outcome.comm,
  tabId: outcome.tabId,
  reason: outcome.kind,
  outcome: outcome.outcome,
});

export interface ISuspectPeer {
  tabId: string;
  sessionName: string;
  cwd: string | null;
  /** The tab's last agent launch (ms); null when unknown. */
  launchedAt: number | null;
}

export interface IOrphanSuspect {
  pid: number;
  comm: string;
  cwd: string | null;
  startedAt: number;
  heldBy: string | null;
}

const samePath = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * The liveness guard: the unmarked agent a tab whose agent reads as gone answers `unknown` for, or null (`absent`).
 * The agent (a) shares the tab's cwd, (b) started after the tab's last launch and (c) no other live session's pane
 * holds it; and of the tabs on the host that share that cwd, this tab's launch is the latest before the agent
 * started. One suspect therefore holds at most one tab.
 */
export const suspectForTab = (tabId: string, peers: readonly ISuspectPeer[], suspects: readonly IOrphanSuspect[]): IOrphanSuspect | null => {
  const self = peers.find((p) => p.tabId === tabId);
  if (!self?.cwd || self.launchedAt === null) return null;
  const ordered = [...suspects].sort((a, b) => b.startedAt - a.startedAt || a.pid - b.pid);
  for (const suspect of ordered) {
    if (!suspect.cwd || !samePath(suspect.cwd, self.cwd)) continue;
    if (suspect.startedAt <= self.launchedAt) continue;
    if (suspect.heldBy !== null && suspect.heldBy !== self.sessionName) continue;
    const match = peers
      .filter((p) => p.cwd && samePath(p.cwd, suspect.cwd!) && p.launchedAt !== null && p.launchedAt < suspect.startedAt)
      .sort((a, b) => b.launchedAt! - a.launchedAt! || a.tabId.localeCompare(b.tabId))[0];
    if (match?.tabId === tabId) return suspect;
  }
  return null;
};

/** A host's unmarked agents as liveness suspects, dated by this server's clock. */
export const suspectsOf = (facts: IOrphanHostFacts, now: number): IOrphanSuspect[] =>
  unmarkedAgents(facts).map((p) => ({ pid: p.pid, comm: printable(p.comm), cwd: p.cwd, startedAt: now - p.ageMs, heldBy: p.heldBy }));
