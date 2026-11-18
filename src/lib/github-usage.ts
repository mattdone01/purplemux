import type { ITabCallRead } from '@/lib/gh-tab-calls';
import type { IOwnerCount } from '@/lib/github-quota-alert';
import type { IQuotaRead, TAccountQuota } from '@/lib/github-quota';
import { DAY_MS, HOUR_MS, type GhCallLedger, type IGhCallCount, type TGhCallSource } from '@/lib/github-usage-ledger';

// `purplemux github usage` (engineering#810): the quota per account, and who spent the calls in the last 1 h and
// 24 h, from the server's own ledger and the tab calls the gh shim logged.

export const GITHUB_USAGE_RESIDUAL = 'residual: a script that resets PATH, or one that runs gh by an absolute path such as '
  + '/usr/bin/gh, is not counted, so the count can be low; nor is a shell whose rc puts another gh before the shim '
  + '(a plain terminal tab, an agent the web UI started, or an agent tool shell that is not bash); remote tabs are '
  + 'not counted';

export const OWNER_LIMIT = 10;
const REDACTED = 'other';

export interface IWorkspaceNames {
  name: string;
  tabs: ReadonlyMap<string, string>;
}

export type TNameIndex = ReadonlyMap<string, IWorkspaceNames>;

export interface IUsageOwner {
  source: TGhCallSource;
  workspaceId: string;
  workspaceName: string | null;
  tabId: string;
  tabName: string | null;
  rest: number;
  graphql: number;
  total: number;
  /** The top 3 recorded subcommands, most calls first. */
  top: Array<{ command: string; count: number }>;
}

export interface IUsageWindow {
  window: '1h' | '24h';
  total: number;
  rest: number;
  graphql: number;
  owners: IUsageOwner[];
  /** Owners past the limit, not listed (their calls are in the totals). */
  ownersOmitted: number;
}

export interface IGithubUsageView {
  at: string;
  quotaReadAt: string | null;
  quotaError: string | null;
  accounts: TAccountQuota[];
  windows: IUsageWindow[];
  serverLedgerStartedAt: string;
  tabLog: { dir: string; shimInstalled: boolean; shimReason: string | null; error: string | null; skippedLines: number };
  footer: string[];
}

export interface IUsageDeps {
  now: () => number;
  ledger: () => GhCallLedger;
  tabCalls: (now: number) => Promise<ITabCallRead>;
  /** The last quota read; null before the first one. */
  quota: () => IQuotaRead | null;
  names: () => Promise<TNameIndex>;
  shim: () => { installed: boolean; reason: string | null };
  tabCallsDir: () => string;
}

const byCountThenName = <T extends { count: number; command: string }>(a: T, b: T): number => b.count - a.count || a.command.localeCompare(b.command);

/** The owners of the calls from `from` on, by source, workspace and tab, most calls first. */
export const aggregateOwners = (counts: readonly IGhCallCount[], from: number, names: TNameIndex, limit: number): Omit<IUsageWindow, 'window'> => {
  const owners = new Map<string, IUsageOwner & { commands: Map<string, number> }>();
  let rest = 0;
  let graphql = 0;
  for (const c of counts) {
    if (c.at < from) continue;
    const key = [c.source, c.workspaceId, c.tabId].join('\u0000');
    let owner = owners.get(key);
    if (!owner) {
      const ws = names.get(c.workspaceId);
      owner = {
        source: c.source, workspaceId: c.workspaceId, workspaceName: ws?.name ?? null, tabId: c.tabId, tabName: ws?.tabs.get(c.tabId) ?? null,
        rest: 0, graphql: 0, total: 0, top: [], commands: new Map(),
      };
      owners.set(key, owner);
    }
    owner[c.kind] += c.count;
    owner.total += c.count;
    const command = `${c.w1} ${c.w2}`;
    owner.commands.set(command, (owner.commands.get(command) ?? 0) + c.count);
    if (c.kind === 'rest') rest += c.count;
    else graphql += c.count;
  }
  const ranked = [...owners.values()]
    .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source) || a.workspaceId.localeCompare(b.workspaceId) || a.tabId.localeCompare(b.tabId))
    .map(({ commands, ...owner }) => ({
      ...owner,
      top: [...commands.entries()].map(([command, count]) => ({ command, count })).sort(byCountThenName).slice(0, 3),
    }));
  return { total: rest + graphql, rest, graphql, owners: ranked.slice(0, limit), ownersOmitted: Math.max(0, ranked.length - limit) };
};

const iso = (ms: number): string => new Date(ms).toISOString();

const footerOf = (deps: IUsageDeps, ledgerStart: number, quota: IQuotaRead | null, tabs: ITabCallRead): string[] => {
  const shim = deps.shim();
  return [
    `server ledger since ${iso(ledgerStart)} (in memory: a restart starts it again)`,
    ...(quota ? [] : ['quota: not read yet (the first read runs within 5 minutes of the start)']),
    ...(tabs.error ? [`tab calls: the log could not be read (${tabs.error}), so the tab counts are missing, not zero`] : []),
    ...(shim.installed ? [] : [`tab calls: no gh shim is installed (${shim.reason ?? 'unknown reason'}), so no tab call is counted`]),
    ...(tabs.skippedLines ? [`tab calls: ${tabs.skippedLines} log lines did not parse and are not counted`] : []),
    GITHUB_USAGE_RESIDUAL,
  ];
};

const allCounts = async (deps: IUsageDeps, now: number): Promise<{ counts: IGhCallCount[]; tabs: ITabCallRead }> => {
  const tabs = await deps.tabCalls(now);
  return { counts: [...deps.ledger().counts(now - DAY_MS, now), ...tabs.counts], tabs };
};

export const buildGithubUsageView = async (deps: IUsageDeps): Promise<IGithubUsageView> => {
  const now = deps.now();
  const [{ counts, tabs }, names] = await Promise.all([allCounts(deps, now), deps.names()]);
  const quota = deps.quota();
  const ledgerStart = deps.ledger().startedAt;
  const shim = deps.shim();
  return {
    at: iso(now),
    quotaReadAt: quota ? iso(quota.at) : null,
    quotaError: quota?.error ?? null,
    accounts: quota?.accounts ?? [],
    windows: [
      { window: '1h', ...aggregateOwners(counts, now - HOUR_MS, names, OWNER_LIMIT) },
      { window: '24h', ...aggregateOwners(counts, now - DAY_MS, names, OWNER_LIMIT) },
    ],
    serverLedgerStartedAt: iso(ledgerStart),
    tabLog: { dir: deps.tabCallsDir(), shimInstalled: shim.installed, shimReason: shim.reason, error: tabs.error, skippedLines: tabs.skippedLines },
    footer: footerOf(deps, ledgerStart, quota, tabs),
  };
};

/** The owners of the last hour by REST calls, both sources together, for the quota alert. */
export const topOwnersLastHour = async (deps: IUsageDeps): Promise<IOwnerCount[]> => {
  const now = deps.now();
  const [{ counts }, names] = await Promise.all([allCounts(deps, now), deps.names()]);
  const rest = new Map<string, { workspaceId: string; tabId: string; rest: number }>();
  for (const c of counts) {
    if (c.at < now - HOUR_MS || c.kind !== 'rest') continue;
    const key = `${c.workspaceId}/${c.tabId}`;
    const owner = rest.get(key) ?? { workspaceId: c.workspaceId, tabId: c.tabId, rest: 0 };
    owner.rest += c.count;
    rest.set(key, owner);
  }
  return [...rest.values()]
    .sort((a, b) => b.rest - a.rest || a.tabId.localeCompare(b.tabId))
    .map((o) => {
      const ws = names.get(o.workspaceId);
      return { label: `${ws?.tabs.get(o.tabId) ?? o.tabId} (${ws?.name ?? o.workspaceId})`, rest: o.rest };
    });
};

/** A caller that cannot read a workspace sees its owners as `other`, with the counts kept (the pool's rule, ADR-0045). */
export const redactGithubUsage = async (view: IGithubUsageView, canRead: (workspaceId: string) => Promise<boolean>): Promise<IGithubUsageView> => {
  const ids = new Set(view.windows.flatMap((w) => w.owners.map((o) => o.workspaceId)).filter((id) => id !== '-'));
  const readable = new Map(await Promise.all([...ids].map(async (id) => [id, await canRead(id)] as const)));
  const redact = (o: IUsageOwner): IUsageOwner => (o.workspaceId === '-' || readable.get(o.workspaceId)
    ? o
    : { ...o, workspaceId: REDACTED, workspaceName: null, tabId: REDACTED, tabName: null });
  return { ...view, windows: view.windows.map((w) => ({ ...w, owners: w.owners.map(redact) })) };
};
