import type { IRateWindow, TAccountQuota } from '@/lib/github-quota';
import { createLogger } from '@/lib/logger';
import type { ITabEventRoute } from '@/lib/tab-event-router';
import { classifyWake } from '@/lib/wake-class';
import type { IPortfolioSelection } from '@/types/portfolio';
import type { IWorkspace } from '@/types/terminal';

// R2: when an agent account's core (REST) remaining is below 20 % of its limit before its reset, one line per
// account per reset window names the counted calls against the quota spent, and the top 3 counted owners of the last hour. The account
// belongs to no workspace, so the line goes where a fleet-level flag goes: the portfolio Scrum Master seat, through
// the tab event router (the pool flag's path, SO-10).

const log = createLogger('github-usage');

export const QUOTA_ALERT_SHARE = 0.2;
export const QUOTA_ALERT_RULE = 'github-quota-low';

export interface IOwnerCount {
  /** `<tab name> (<workspace name>)`, or the ids when the layout has no name. */
  label: string;
  rest: number;
}

export interface IQuotaAlertState {
  /** Per account, the reset (epoch s) whose window already had its line. */
  sent: Map<string, number>;
  /** Per account, the reset whose missing target was already logged. */
  loggedNoTarget: Map<string, number>;
}

export const createQuotaAlertState = (): IQuotaAlertState => ({ sent: new Map(), loggedNoTarget: new Map() });

export interface IQuotaAlertDeps {
  scrumMaster: () => Promise<IPortfolioSelection | null>;
  workspaces: () => Promise<IWorkspace[]>;
  routeTabEvent: (event: ITabEventRoute) => Promise<unknown>;
  /** The owners of the last hour, most REST calls first. */
  topOwners: () => Promise<IOwnerCount[]>;
  /** The REST calls counted (server ledger and tab log, any account) from `fromMs` on. */
  countedRestSince: (fromMs: number) => Promise<number>;
}

const resetIso = (reset: number): string => new Date(reset * 1000).toISOString();

/** GitHub's core window is one hour, so it began one hour before its reset. */
export const coreWindowStart = (core: IRateWindow): number => core.reset * 1000 - 60 * 60_000;

/**
 * The counted calls beside the quota the account spent this window. A count below half of the spent quota says so: the
 * top owners then explain a part only, and the rest came from outside the counted tabs.
 */
export const coverageText = (core: IRateWindow, counted: number): string => {
  const spent = Math.max(0, core.limit - core.remaining);
  const share = spent > 0 ? `${Math.floor((counted / spent) * 100)}%` : 'none spent';
  const most = spent > 0 && counted * 2 < spent
    ? '; most calls are not counted: another process or host on the account, or a long poll such as gh run watch'
    : '';
  return `counted ${counted} REST calls (any account) of ${spent} spent since ${new Date(coreWindowStart(core)).toISOString()} (${share})${most}`;
};

export const quotaAlertText = (login: string, core: IRateWindow, owners: IOwnerCount[], counted: number): string => {
  const pct = Math.floor((core.remaining / core.limit) * 100);
  const top = owners.slice(0, 3).map((o) => `${o.label} ${o.rest} REST`).join(', ') || 'none counted';
  return `GitHub REST quota low: ${login} core ${core.remaining}/${core.limit} (${pct}%), resets ${resetIso(core.reset)}; `
    + `${coverageText(core, counted)}; top counted owners, last hour: ${top}`;
};

const isLow = (q: TAccountQuota, now: number): q is Extract<TAccountQuota, { state: 'read' }> =>
  q.state === 'read' && q.core.remaining < q.core.limit * QUOTA_ALERT_SHARE && now < q.core.reset * 1000;

type TTarget = { ok: true; workspaceId: string; tabId: string } | { ok: false; reason: string };

const seatOf = async (deps: IQuotaAlertDeps): Promise<TTarget> => {
  const seat = await deps.scrumMaster();
  if (!seat) return { ok: false, reason: 'no-scrum-master' };
  const workspace = (await deps.workspaces()).find((w) => w.id === seat.managerWorkspaceId);
  const orchestration = workspace?.orchestration;
  if (!orchestration?.orchestratorTabId) return { ok: false, reason: 'no-orchestrator' };
  if (!orchestration.enabled) return { ok: false, reason: 'orchestrator-disabled' };
  if (orchestration.orchestratorTabId !== seat.managerTabId) return { ok: false, reason: 'scrum-master-not-current' };
  return { ok: true, workspaceId: seat.managerWorkspaceId, tabId: seat.managerTabId };
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Send the lines due after one quota read. A line with no target, or one the router refuses, is not marked: the next
 * read tries it again within the same window.
 */
export const runQuotaAlerts = async (
  deps: IQuotaAlertDeps, state: IQuotaAlertState, accounts: TAccountQuota[], now: number,
): Promise<{ sent: string[]; noTarget: string[] }> => {
  for (const [login, reset] of state.sent) if (now >= reset * 1000) state.sent.delete(login);
  const due = accounts.filter((q) => isLow(q, now)).filter((q) => state.sent.get(q.login) !== q.core.reset);
  const result = { sent: [] as string[], noTarget: [] as string[] };
  if (!due.length) return result;
  let target: TTarget;
  let owners: IOwnerCount[];
  try {
    [target, owners] = await Promise.all([seatOf(deps), deps.topOwners()]);
  } catch (err) {
    log.warn(`github quota alert not sent: ${errorText(err)}`);
    return result;
  }
  for (const q of due) {
    if (!target.ok) {
      result.noTarget.push(`${q.login}: ${target.reason}`);
      if (state.loggedNoTarget.get(q.login) !== q.core.reset) {
        state.loggedNoTarget.set(q.login, q.core.reset);
        log.warn({ login: q.login, reason: target.reason }, 'github quota alert has no target');
      }
      continue;
    }
    let counted: number;
    try {
      counted = await deps.countedRestSince(coreWindowStart(q.core));
    } catch (err) {
      log.warn(`github quota alert for ${q.login} not sent: ${errorText(err)}`);
      continue;
    }
    const event: ITabEventRoute = {
      workspaceId: target.workspaceId, tabId: target.tabId, kind: 'flag', text: quotaAlertText(q.login, q.core, owners, counted),
      class: classifyWake('flag', { severity: 'warn' }), rule: QUOTA_ALERT_RULE,
    };
    try {
      await deps.routeTabEvent(event);
    } catch (err) {
      log.warn(`github quota alert for ${q.login} not routed to ${target.tabId}: ${errorText(err)}`);
      continue;
    }
    state.sent.set(q.login, q.core.reset);
    result.sent.push(q.login);
  }
  return result;
};
