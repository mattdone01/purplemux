import {
  CLOSE_CHECKS,
  DORMANT_CLOSES_PER_PASS,
  DORMANT_REPORT_EVERY_MS,
  DORMANT_STATES,
  holdsOf,
  isAgentPanel,
  judgeActivity,
  keepHolds,
  readDormantPolicy,
  worktreeVerdict,
  type IDormantCandidate,
  type IDormantPane,
  type IDormantPassReads,
  type IDormantPolicy,
  type IDormantWorkspaceReads,
} from '@/lib/dormant-sweep';
import type { IDormantStatusFacts, TDormantRead } from '@/types/dormant';
import type { IGitFacts } from '@/types/rotation-checkpoint';
import type { ITab } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';

export interface IDormantWorkspace {
  workspaceId: string;
  tabs: IDormantCandidate[];
}

/** What the close re-reads under the layout lock, synchronously (`StatusManager.dormantGuard`). */
export interface IDormantGuard {
  cliState: TCliState;
  eventSeq: number;
  retired: boolean;
  restarting: boolean;
}

export interface IDormantCloseResult {
  ok: boolean;
  refused?: string;
}

export interface IDormantLog {
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

export interface IDormantSweeperDeps {
  now: () => number;
  config: (key: string) => Promise<string | null>;
  /** Every workspace whose layout read, with its agent and other tabs; throws when the workspaces cannot be listed. */
  listWorkspaces: () => Promise<{ workspaces: IDormantWorkspace[]; uncertainWorkspaceIds: ReadonlySet<string> }>;
  passReads: () => Promise<IDormantPassReads>;
  workspaceReads: (workspaceId: string) => IDormantWorkspaceReads;
  status: (tabId: string) => Promise<IDormantStatusFacts | null>;
  pane: (tab: ITab) => Promise<IDormantPane>;
  jobs: (tabId: string) => Promise<number>;
  gitFacts: (host: string | null, cwd: string) => Promise<IGitFacts>;
  guard: (tabId: string) => IDormantGuard | null;
  close: (workspaceId: string, paneId: string, tabId: string, refuseIf: (tab: ITab) => string | null) => Promise<IDormantCloseResult>;
  note: (workspaceId: string, subject: string, body: string) => Promise<void>;
  audit: (entry: Record<string, unknown>) => Promise<unknown>;
  log: IDormantLog;
}

export type TDormantOutcome = 'active' | 'held' | 'would-close' | 'confirming' | 'closed' | 'close-deferred' | 'close-refused' | 'close-failed';

export interface IDormantTabResult {
  workspaceId: string;
  tabId: string;
  outcome: TDormantOutcome;
  holds?: string[];
  detail?: string;
}

interface IFreeTab {
  candidate: IDormantCandidate;
  status: IDormantStatusFacts;
  lastActivityAt: number;
  source: string;
  worktree: string;
}

const read = async <T>(fn: () => Promise<T>): Promise<TDormantRead<T>> => {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

const iso = (at: number | null): string => (at === null ? 'unknown' : new Date(at).toISOString());
const hoursAgo = (now: number, at: number): string => `${((now - at) / 3_600_000).toFixed(1)} h`;
const label = (tab: ITab): string => `${tab.name} (${tab.id})`;

/**
 * One pass over every agent tab (ADR-0048). In memory: the report-once keys and the two-pass confirm. A restart
 * repeats at most one report line per tab and delays the first close by two passes.
 */
export class DormantSweeper {
  /** `<kind>:<tabId>` -> when it was last reported. */
  private readonly reported = new Map<string, number>();
  /** A tab found dormant and free in close mode, with the eventSeq it was judged at. */
  private readonly confirming = new Map<string, number>();
  private readonly policyLogged = new Map<string, string>();
  private running = false;

  constructor(private readonly deps: IDormantSweeperDeps) {}

  async sweep(): Promise<IDormantTabResult[] | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.pass();
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<IDormantTabResult[]> {
    const now = this.deps.now();
    const { workspaces, uncertainWorkspaceIds } = await this.deps.listWorkspaces();
    this.forgetGone(workspaces, uncertainWorkspaceIds);
    const results: IDormantTabResult[] = [];
    const policies = new Map<string, IDormantPolicy>();
    for (const ws of workspaces) {
      if (uncertainWorkspaceIds.has(ws.workspaceId)) continue;
      const policy = await readDormantPolicy(this.deps.config, ws.workspaceId);
      this.logPolicy(ws.workspaceId, policy);
      if (policy.mode !== 'off') policies.set(ws.workspaceId, policy);
    }
    if (policies.size === 0) return results;
    const passReads = await this.deps.passReads();
    const free: IFreeTab[] = [];
    for (const ws of workspaces) {
      const policy = policies.get(ws.workspaceId);
      if (!policy) continue;
      const wsReads = this.deps.workspaceReads(ws.workspaceId);
      for (const candidate of ws.tabs) {
        if (!isAgentPanel(candidate.tab.panelType)) continue;
        const result = await this.judge(candidate, policy, passReads, wsReads, now);
        if ('free' in result) free.push(result.free);
        else results.push(result.result);
      }
    }
    results.push(...(await this.closeFree(free, policies, now)));
    return results;
  }

  private async judge(
    candidate: IDormantCandidate,
    policy: IDormantPolicy,
    pass: IDormantPassReads,
    workspace: IDormantWorkspaceReads,
    now: number,
  ): Promise<{ result: IDormantTabResult } | { free: IFreeTab }> {
    const { workspaceId, tab } = candidate;
    const base = { workspaceId, tabId: tab.id };
    const status = await this.deps.status(tab.id);
    if (!status) {
      this.confirming.delete(tab.id);
      return { result: { ...base, outcome: 'active', detail: 'status unknown' } };
    }
    const pane = await this.deps.pane(tab);
    const ledgerAt: TDormantRead<number | null> = workspace.ledger.ok
      ? { ok: true, value: workspace.ledger.value.get(tab.id) ?? null }
      : workspace.ledger;
    const activity = judgeActivity({ tab, status, pane, ledgerAt }, policy.hours, now);
    if (activity.kind === 'active') {
      this.confirming.delete(tab.id);
      return { result: { ...base, outcome: 'active', detail: activity.reason } };
    }
    const holds = [...activity.holds, ...holdsOf({ candidate, status, pass, workspace, jobs: await read(() => this.deps.jobs(tab.id)) }, now)];
    let worktree = 'not read (already held)';
    if (holds.length === 0) {
      const facts = pane.cwd === null ? null : await read(() => this.deps.gitFacts(tab.host ?? null, pane.cwd!));
      const verdict = worktreeVerdict(pane.cwd, facts ?? { ok: false, error: 'no cwd' });
      worktree = verdict.answer;
      if (verdict.hold) holds.push(verdict.hold);
    }
    const since = activity.lastActivityAt === null ? 'unknown' : `${hoursAgo(now, activity.lastActivityAt)} (${activity.source}, ${iso(activity.lastActivityAt)})`;
    if (holds.length > 0) {
      this.confirming.delete(tab.id);
      await this.reportOnce('dormant-held', candidate, now,
        `dormant tab ${label(tab)} in ${workspaceId} held, not closed: last activity ${since}; holds: ${holds.join('; ')}`,
        { holds, lastActivityAt: activity.lastActivityAt, source: activity.source, state: status.cliState });
      return { result: { ...base, outcome: 'held', holds } };
    }
    const lastActivityAt = activity.lastActivityAt!;
    if (policy.mode === 'report') {
      await this.reportOnce('would-close', candidate, now,
        `dormant tab ${label(tab)} in ${workspaceId} would close (mode report): last activity ${since}, state ${status.cliState}; worktree ${worktree}`,
        { lastActivityAt, source: activity.source, state: status.cliState, worktree });
      return { result: { ...base, outcome: 'would-close' } };
    }
    if (this.confirming.get(tab.id) !== status.eventSeq) {
      this.confirming.set(tab.id, status.eventSeq);
      return { result: { ...base, outcome: 'confirming' } };
    }
    return { free: { candidate, status, lastActivityAt, source: activity.source!, worktree } };
  }

  private async closeFree(free: IFreeTab[], policies: Map<string, IDormantPolicy>, now: number): Promise<IDormantTabResult[]> {
    const results: IDormantTabResult[] = [];
    const closedByWorkspace = new Map<string, Array<{ item: IFreeTab; hours: number }>>();
    free.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    for (const [index, item] of free.entries()) {
      const { workspaceId, paneId, tab } = item.candidate;
      const base = { workspaceId, tabId: tab.id };
      if (index >= DORMANT_CLOSES_PER_PASS) {
        this.deps.log.info(`dormant tab ${label(tab)} in ${workspaceId} close-deferred: ${DORMANT_CLOSES_PER_PASS} closes already this pass`);
        await this.audit({ event: 'dormant-close-deferred', workspaceId, tabId: tab.id, lastActivityAt: item.lastActivityAt });
        results.push({ ...base, outcome: 'close-deferred' });
        continue;
      }
      const judgedSeq = item.status.eventSeq;
      let closed: IDormantCloseResult;
      try {
        closed = await this.deps.close(workspaceId, paneId, tab.id, (current) => this.refusal(current, judgedSeq, now));
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        this.deps.log.warn(`dormant tab ${label(tab)} in ${workspaceId} close failed: ${why}`);
        await this.audit({ event: 'dormant-close-failed', workspaceId, tabId: tab.id, error: why });
        results.push({ ...base, outcome: 'close-failed', detail: why });
        continue;
      }
      this.confirming.delete(tab.id);
      if (!closed.ok) {
        const why = closed.refused ?? 'the layout no longer names the tab';
        this.deps.log.info(`dormant tab ${label(tab)} in ${workspaceId} not closed: ${why}`);
        await this.audit({ event: 'dormant-close-refused', workspaceId, tabId: tab.id, reason: why });
        results.push({ ...base, outcome: 'close-refused', detail: why });
        continue;
      }
      const hours = policies.get(workspaceId)!.hours;
      this.deps.log.info(`dormant tab ${label(tab)} in ${workspaceId} closed: no turn for ${hoursAgo(now, item.lastActivityAt)} `
        + `(last activity ${item.source}, ${iso(item.lastActivityAt)}; threshold ${hours} h), state ${item.status.cliState}, `
        + `no holds; worktree ${item.worktree}`);
      await this.audit({
        event: 'dormant-close', workspaceId, tabId: tab.id, tabName: tab.name, state: item.status.cliState,
        lastActivityAt: item.lastActivityAt, source: item.source, thresholdHours: hours, checked: CLOSE_CHECKS,
        worktree: item.worktree, agentSessionId: item.status.agentSessionId, jsonlPath: item.status.jsonlPath,
      });
      const list = closedByWorkspace.get(workspaceId) ?? [];
      list.push({ item, hours });
      closedByWorkspace.set(workspaceId, list);
      results.push({ ...base, outcome: 'closed' });
    }
    for (const [workspaceId, closed] of closedByWorkspace) await this.sendNote(workspaceId, closed, now);
    return results;
  }

  /** Read under the layout lock, after the judgement: anything that moved since keeps the tab. */
  private refusal(tab: ITab, judgedSeq: number, now: number): string | null {
    if (tab.orchestrationActivity?.launch || tab.orchestrationActivity?.turn) return 'orchestration-pending';
    if (keepHolds(tab.keep, now)) return 'keep';
    const guard = this.deps.guard(tab.id);
    if (!guard) return 'status unknown';
    if (guard.retired) return 'closing';
    if (guard.restarting) return 'restarting';
    if (guard.eventSeq !== judgedSeq) return 'activity since the judgement';
    if (!DORMANT_STATES.has(guard.cliState)) return `state ${guard.cliState}`;
    return null;
  }

  private async sendNote(workspaceId: string, closed: Array<{ item: IFreeTab; hours: number }>, now: number): Promise<void> {
    const subject = closed.length === 1
      ? `dormant tab closed: ${closed[0].item.candidate.tab.name}`
      : `dormant tabs closed: ${closed.length}`;
    const lines = closed.map(({ item, hours }) => {
      const { tab } = item.candidate;
      const resume = item.status.agentSessionId ? `; agent session ${item.status.agentSessionId}` : '';
      const transcript = item.status.jsonlPath ? `; transcript ${item.status.jsonlPath}` : '';
      return [
        `- ${label(tab)}: no turn for ${hoursAgo(now, item.lastActivityAt)} (threshold ${hours} h), state ${item.status.cliState}.`,
        `  Last activity: ${item.source}, ${iso(item.lastActivityAt)}${resume}${transcript}.`,
        `  Checked, none held: ${CLOSE_CHECKS.join(', ')}. Worktree: ${item.worktree}.`,
      ].join('\n');
    });
    const body = [
      `The dormant-tab sweep (tabs.dormant.mode close) closed ${closed.length === 1 ? 'this tab' : 'these tabs'}:`,
      '',
      ...lines,
      '',
      'To keep a tab open, run: purplemux tab keep -w <workspace> <tab> --reason <why> [--until 12h].',
    ].join('\n');
    try {
      await this.deps.note(workspaceId, subject, body);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.deps.log.error(`dormant-close note to ${workspaceId} failed: ${why}`);
      await this.audit({ event: 'dormant-close-note-failed', workspaceId, tabIds: closed.map((c) => c.item.candidate.tab.id), error: why });
    }
  }

  private async reportOnce(
    kind: 'dormant-held' | 'would-close',
    candidate: IDormantCandidate,
    now: number,
    line: string,
    facts: Record<string, unknown>,
  ): Promise<void> {
    const key = `${kind}:${candidate.tab.id}`;
    const last = this.reported.get(key);
    if (last !== undefined && now - last < DORMANT_REPORT_EVERY_MS) return;
    this.reported.set(key, now);
    this.deps.log.info(line);
    await this.audit({ event: `dormant-${kind === 'dormant-held' ? 'held' : 'would-close'}`, workspaceId: candidate.workspaceId, tabId: candidate.tab.id, tabName: candidate.tab.name, ...facts });
  }

  private async audit(entry: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.audit(entry);
    } catch (err) {
      this.deps.log.warn(`dormant audit failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private forgetGone(workspaces: IDormantWorkspace[], uncertain: ReadonlySet<string>): void {
    const live = new Set(workspaces.flatMap((ws) => ws.tabs.map((c) => c.tab.id)));
    // A tab of a workspace whose layout did not read is unknown, not gone: its keys stay.
    if (uncertain.size > 0) return;
    for (const key of [...this.reported.keys()]) if (!live.has(key.slice(key.indexOf(':') + 1))) this.reported.delete(key);
    for (const tabId of [...this.confirming.keys()]) if (!live.has(tabId)) this.confirming.delete(tabId);
  }

  private logPolicy(workspaceId: string, policy: IDormantPolicy): void {
    const line = `dormant sweep for ${workspaceId}: mode ${policy.mode} (${policy.modeSource}), ${policy.hours} h (${policy.hoursSource})`
      + (policy.reasons.length ? `; ${policy.reasons.join('; ')}` : '');
    if (this.policyLogged.get(workspaceId) === line) return;
    this.policyLogged.set(workspaceId, line);
    if (policy.reasons.length) this.deps.log.warn(line);
    else this.deps.log.info(line);
  }
}

