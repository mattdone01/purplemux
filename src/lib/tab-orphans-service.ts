import fs from 'fs/promises';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { collectAllTabs } from '@/lib/layout-tree';
import { resolveLayoutFile } from '@/lib/layout-store';
import { readAllLiveness } from '@/lib/liveness-store';
import { readRemoteHosts, resolveCallbackUrl } from '@/lib/remote-host';
import { readServerPort } from '@/lib/server-port';
import {
  classifyOrphans,
  collectLocalOrphanFacts,
  defaultOrphanScanDeps,
  orphanReapAudit,
  reapLocalOrphans,
  reapRefusal,
  suspectsOf,
  viewOrphan,
  type IOrphanEntry,
  type IOrphanHostFacts,
  type IOrphanReapOutcome,
  type IOrphanReapTarget,
  type IOrphanSuspect,
  type IOrphanView,
  type IOwnedTab,
  type TOrphanRefusal,
  type TOrphanTree,
} from '@/lib/tab-orphans';
import { defaultReaperDeps } from '@/lib/tab-reaper';
import { getDescendantPids, getTmuxServerPid, getTmuxSocketPath, readLocalTree, reapRemoteOrphans, scanRemoteOrphans } from '@/lib/tmux';
import { workspaceIdFromSessionName } from '@/lib/workspace-home';
import { getWorkspaces } from '@/lib/workspace-store';
import type { ILayoutData } from '@/types/terminal';

/** The name `--host` and every report give this server's own host. */
export const LOCAL_HOST = 'local';

export type TOrphanSweepErrorCode = 'invalid-request' | 'remote-host-invalid' | 'conflict';

export class OrphanSweepError extends Error {
  constructor(readonly code: TOrphanSweepErrorCode, message: string) {
    super(message);
    this.name = 'OrphanSweepError';
  }
}

export interface IOwnership {
  tabs: Map<string, IOwnedTab>;
  workspaces: number;
  /** Workspaces whose layout file does not exist: their tabs, if any run, are unknown. */
  missingLayouts: string[];
}

/**
 * Every tab of every layout. A layout that exists but cannot be read throws: read as empty, its tabs would all be
 * orphans and a reap would end them. A layout file that does not exist is named in `missingLayouts`: a workspace may
 * have no layout yet, but one that has live tabs and lost its file would make them all orphans, so a reap refuses
 * every unowned-tab process while one is missing.
 */
export const readOwnership = async (): Promise<IOwnership> => {
  const { workspaces } = await getWorkspaces();
  const tabs = new Map<string, IOwnedTab>();
  const missingLayouts: string[] = [];
  for (const ws of workspaces) {
    let raw: string;
    try {
      raw = await fs.readFile(resolveLayoutFile(ws.id), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        missingLayouts.push(ws.id);
        continue;
      }
      throw new OrphanSweepError('conflict', `the layout of ${ws.id} is unreadable; no orphan is judged without it`);
    }
    let layout: ILayoutData;
    try {
      layout = JSON.parse(raw) as ILayoutData;
    } catch {
      throw new OrphanSweepError('conflict', `the layout of ${ws.id} does not parse; no orphan is judged without it`);
    }
    if (!layout?.root) continue;
    for (const tab of collectAllTabs(layout.root)) tabs.set(tab.id, { workspaceId: ws.id, sessionName: tab.sessionName, host: tab.host ?? null });
  }
  return { tabs, workspaces: workspaces.length, missingLayouts };
};

/** The local host, then each host of remote.hosts that owns a tab; or the one host named. */
const sweepHosts = async (ownership: IOwnership, requested: string | undefined): Promise<string[]> => {
  const registered = await readRemoteHosts();
  if (requested !== undefined) {
    if (requested === LOCAL_HOST) return [LOCAL_HOST];
    if (!registered.includes(requested)) throw new OrphanSweepError('remote-host-invalid', `${requested} is neither "${LOCAL_HOST}" nor a host of remote.hosts`);
    return [requested];
  }
  const owning = new Set([...ownership.tabs.values()].map((t) => t.host).filter((h): h is string => !!h));
  return [LOCAL_HOST, ...registered.filter((h) => owning.has(h))];
};

const localScanDeps = () => defaultOrphanScanDeps(defaultReaperDeps({ descendants: getDescendantPids, tmuxServerPid: getTmuxServerPid }));

/** The PMUX_URL values that name this server on its own host. */
const localUrls = async (): Promise<string[]> => {
  const port = readServerPort();
  const urls = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const fleet = await resolveCallbackUrl().catch(() => null);
  if (fleet) urls.push(fleet);
  return [...new Set(urls)];
};

/** One host's facts; null without /proc. Throws when a remote host does not answer. */
const scanHost = async (host: string): Promise<IOrphanHostFacts | null> => {
  if (host !== LOCAL_HOST) {
    const facts = await scanRemoteOrphans(host, await resolveCallbackUrl(host));
    return facts === 'unavailable' ? null : facts;
  }
  const [tree, socketPath, urls] = await Promise.all([readLocalTree(), getTmuxSocketPath(), localUrls()]);
  return collectLocalOrphanFacts(localScanDeps(), { urls, socketPath, tree });
};

export interface IOrphanHostReport {
  host: string;
  /** `unavailable`: no /proc on this host; `unreachable`: the remote host did not answer. */
  status: 'ok' | 'unreachable' | 'unavailable';
  /** `ok` only: whether the pane tree was read whole. When it was not, nothing on the host is reaped. */
  tree?: TOrphanTree;
  error?: string;
  orphans: IOrphanView[];
  reaped?: IOrphanReapOutcome[];
}

export interface IOrphanHostEntries {
  host: string;
  status: IOrphanHostReport['status'];
  tree?: TOrphanTree;
  entries: IOrphanEntry[];
}

/** Whether the caller may reap this entry: (ii) belongs to its tab's workspace, (i) to no workspace. */
export type TMayReap = (entry: IOrphanEntry) => Promise<boolean> | boolean;

const printableError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const reapHost = async (
  host: string,
  facts: IOrphanHostFacts,
  entries: readonly IOrphanEntry[],
  ownership: IOwnership,
  mayReap: TMayReap,
): Promise<{ outcomes: IOrphanReapOutcome[]; error?: string }> => {
  const outcomes: IOrphanReapOutcome[] = [];
  const targets: IOrphanReapTarget[] = [];
  const outcomeOf = (t: IOrphanReapTarget, outcome: IOrphanReapOutcome['outcome'], refusal?: TOrphanRefusal): IOrphanReapOutcome => ({
    pid: t.entry.process.pid, comm: viewOrphan(t.entry).comm ?? '', tabId: t.entry.process.tabId, kind: t.entry.kind, outcome, ...(refusal ? { refusal } : {}),
  });
  for (const entry of entries) {
    if (entry.kind !== 'unowned-tab' && entry.kind !== 'duplicate-agent') continue;
    const target = { entry };
    const refusal = reapRefusal(entry, facts.tree)
      ?? (entry.kind === 'unowned-tab' && ownership.missingLayouts.length > 0 ? 'layout-missing' : null)
      ?? ((await mayReap(entry)) ? null : 'forbidden');
    if (refusal) outcomes.push(outcomeOf(target, 'refused', refusal));
    else targets.push(target);
  }
  if (targets.length === 0) return { outcomes };
  let error: string | undefined;
  let signalled: IOrphanReapOutcome[];
  if (host === LOCAL_HOST) {
    signalled = await reapLocalOrphans(localScanDeps(), targets, facts.tree, () => readLocalTree());
  } else {
    try {
      const reap = await reapRemoteOrphans(host, targets.map((t) => ({ pid: t.entry.process.pid, start: t.entry.process.start })));
      const killed = new Set(reap.killed);
      const survivors = new Set(reap.survivors);
      const refused = new Map(reap.refused.map((r) => [r.pid, r.refusal]));
      signalled = targets.map((t) => {
        const pid = t.entry.process.pid;
        if (refused.has(pid)) return outcomeOf(t, 'refused', refused.get(pid));
        if (killed.has(pid)) return outcomeOf(t, 'killed');
        return outcomeOf(t, survivors.has(pid) ? 'survivor' : 'unknown');
      });
    } catch (err) {
      error = printableError(err);
      signalled = targets.map((t) => outcomeOf(t, 'unknown'));
    }
  }
  for (const outcome of signalled) {
    if (outcome.outcome !== 'refused') await appendCoordinationAudit(orphanReapAudit(host, outcome));
  }
  return { outcomes: [...outcomes, ...signalled], ...(error ? { error } : {}) };
};

interface IHostSweep {
  status: IOrphanHostReport['status'];
  error?: string;
  facts: IOrphanHostFacts | null;
  entries: IOrphanEntry[];
}

const scanAndClassify = async (
  host: string,
  ownership: IOwnership,
  registered: ReadonlyArray<{ pid: number; host?: string | null }>,
): Promise<IHostSweep> => {
  let facts: IOrphanHostFacts | null;
  try {
    facts = await scanHost(host);
  } catch (err) {
    return { status: 'unreachable', error: printableError(err), facts: null, entries: [] };
  }
  if (!facts) return { status: 'unavailable', facts: null, entries: [] };
  const remote = host === LOCAL_HOST ? null : host;
  // A job saved before jobs named their host may run on either: it counts on both.
  const registeredPids = new Set(registered.filter((j) => j.host === undefined || (j.host ?? null) === remote).map((j) => j.pid));
  return { status: 'ok', facts, entries: classifyOrphans(remote, facts, { tabs: ownership.tabs, registeredPids }) };
};

const registeredJobs = async () => (await readAllLiveness()).jobs;

/**
 * `purplemux tab orphans`: the four lists per host, and with `mayReap` the reap of kinds (i) and (ii). Unowned
 * sessions and unmarked agents are listed, never signalled. Each signalled process writes one
 * `tab-orphan-reap` audit line.
 */
export const sweepOrphans = async (opts: { host?: string; mayReap?: TMayReap } = {}): Promise<{ hosts: IOrphanHostReport[] }> => {
  const ownership = await readOwnership();
  if (opts.mayReap && ownership.workspaces === 0) {
    throw new OrphanSweepError('conflict', 'no workspace was read, so every marked process would read as an orphan: nothing is reaped');
  }
  const hosts = await sweepHosts(ownership, opts.host);
  const jobs = await registeredJobs();
  const reports: IOrphanHostReport[] = [];
  for (const host of hosts) {
    const scan = await scanAndClassify(host, ownership, jobs);
    const report: IOrphanHostReport = {
      host,
      status: scan.status,
      ...(scan.facts ? { tree: scan.facts.tree } : {}),
      ...(scan.error ? { error: scan.error } : {}),
      orphans: scan.entries.map(viewOrphan),
    };
    if (opts.mayReap && scan.facts) {
      const reap = await reapHost(host, scan.facts, scan.entries, ownership, opts.mayReap);
      report.reaped = reap.outcomes;
      if (reap.error) report.error = reap.error;
    }
    reports.push(report);
  }
  return { hosts: reports };
};

/** The watchdog's hourly list: every host's entries, with the workspace each one belongs to where one does. */
export const listOrphanEntries = async (): Promise<IOrphanHostEntries[]> => {
  const ownership = await readOwnership();
  const hosts = await sweepHosts(ownership, undefined);
  const jobs = await registeredJobs();
  const result: IOrphanHostEntries[] = [];
  for (const host of hosts) {
    const scan = await scanAndClassify(host, ownership, jobs);
    result.push({ host, status: scan.status, ...(scan.facts ? { tree: scan.facts.tree } : {}), entries: scan.entries });
  }
  return result;
};

/** The workspace an entry belongs to, or null when nothing names one. */
export const orphanWorkspace = (entry: IOrphanEntry): string | null => {
  if (entry.kind === 'duplicate-agent') return entry.workspaceId ?? null;
  if (entry.kind === 'unowned-session') return workspaceIdFromSessionName(entry.session.name);
  return null;
};

/**
 * The liveness guard's input: a host's unmarked agents; null when the host could not be read. The clock is read
 * before the scan, so the scan's own time can only date a suspect earlier.
 */
export const findOrphanSuspects = async (host: string | null): Promise<IOrphanSuspect[] | null> => {
  const now = Date.now();
  try {
    const facts = await scanHost(host ?? LOCAL_HOST);
    return facts ? suspectsOf(facts, now) : null;
  } catch {
    return null;
  }
};
