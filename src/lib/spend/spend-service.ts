import { createLogger } from '@/lib/logger';
import { collectAllTabs } from '@/lib/layout-tree';
import { getProviderByPanelType } from '@/lib/providers';
import { toSessionHistoryProvider } from '@/lib/agent-panel-types';
import { getSessionHistory } from '@/lib/session-history';
import { getWorkspaces } from '@/lib/workspace-store';
import { readWorkspaceLayout } from '@/lib/workspace-layout-read';
import { readSessionTabs, seedSessionTabs, SessionTabsStoreError } from '@/lib/spend/session-tabs-store';
import type { ISessionTabSighting } from '@/lib/spend/session-tabs-store';
import { loadSpendIndex, spendIndexStatus, spendIndexUsage, startSpendIndexer, stopSpendIndexer } from '@/lib/spend/spend-index';
import {
  addUtcDays, buildSpendView, isUtcDay, MAX_SPEND_RANGE_DAYS, rangeDays, spendFloor, tokensByDay, utcDay,
} from '@/lib/spend/spend-model';
import type { ISpendBindingRef, ISpendWorkspaceRef } from '@/lib/spend/spend-model';
import type { ISpendTokensByDay, ISpendView, TSpendBy, TSpendPeriod } from '@/types/spend';

const log = createLogger('spend');

const CLI_BY: readonly TSpendBy[] = ['tab', 'day', 'model', 'role'];
const MISSION_BY: readonly TSpendBy[] = ['tab', 'day', 'model', 'role', 'workspace'];
const PERIOD_DAYS: Record<TSpendPeriod, number> = { today: 1, '7d': 7, '30d': 30 };
const DEFAULT_DAYS = 7;

export interface ISpendQuery {
  workspaceId: string | 'all';
  from: string;
  to: string;
  by: TSpendBy;
}

export type TSpendQueryResult = { ok: true; query: ISpendQuery } | { ok: false; error: string };

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

const parseBy = (raw: string | undefined, allowed: readonly TSpendBy[]): TSpendBy | null => {
  const by = raw ?? 'tab';
  return (allowed as readonly string[]).includes(by) ? (by as TSpendBy) : null;
};

/** `GET /api/cli/spend`: `since`/`until` are UTC days; the default is the last 7 UTC days, `by=tab`. */
export const parseCliSpendQuery = (query: Record<string, string | string[] | undefined>, now = Date.now()): TSpendQueryResult => {
  const workspaceId = single(query.workspaceId);
  if (!workspaceId) return { ok: false, error: 'workspaceId is required' };
  const by = parseBy(single(query.by), CLI_BY);
  if (!by) return { ok: false, error: `by: saw ${JSON.stringify(single(query.by))}, expected one of ${CLI_BY.join(', ')}` };
  const since = single(query.since);
  const until = single(query.until);
  for (const [name, value] of [['since', since], ['until', until]] as const) {
    if (value !== undefined && !isUtcDay(value)) return { ok: false, error: `${name}: saw ${JSON.stringify(value)}, expected a UTC day YYYY-MM-DD` };
  }
  const to = until ?? utcDay(now);
  const from = since ?? addUtcDays(to, -(DEFAULT_DAYS - 1));
  if (from > to) return { ok: false, error: `since ${from} is after until ${to}` };
  const days = rangeDays(from, to);
  if (days > MAX_SPEND_RANGE_DAYS) return { ok: false, error: `range: saw ${days} days, expected at most ${MAX_SPEND_RANGE_DAYS}` };
  const floor = spendFloor(now);
  if (from < floor) {
    return { ok: false, error: `since: saw ${from}, expected a day on or after ${floor} (spend keeps the last ${MAX_SPEND_RANGE_DAYS} UTC days)` };
  }
  return { ok: true, query: { workspaceId, from, to, by } };
};

/** `GET /api/mission-control/spend`: `workspaceId=WS|all`, `period=today|7d|30d`; `by=workspace` only with `all`. */
export const parseMissionSpendQuery = (query: Record<string, string | string[] | undefined>, now = Date.now()): TSpendQueryResult => {
  const workspaceId = single(query.workspaceId);
  if (!workspaceId) return { ok: false, error: 'workspaceId is required (a workspace id or all)' };
  const period = single(query.period) ?? '7d';
  if (!Object.hasOwn(PERIOD_DAYS, period)) return { ok: false, error: `period: saw ${JSON.stringify(period)}, expected today, 7d or 30d` };
  const by = parseBy(single(query.by), MISSION_BY);
  if (!by) return { ok: false, error: `by: saw ${JSON.stringify(single(query.by))}, expected one of ${MISSION_BY.join(', ')}` };
  if (by === 'workspace' && workspaceId !== 'all') return { ok: false, error: 'by=workspace needs workspaceId=all' };
  const to = utcDay(now);
  return { ok: true, query: { workspaceId, from: addUtcDays(to, -(PERIOD_DAYS[period as TSpendPeriod] - 1)), to, by } };
};

const loadWorkspaceRefs = async (): Promise<ISpendWorkspaceRef[]> => {
  const { workspaces } = await getWorkspaces();
  return Promise.all(workspaces.map(async (workspace) => {
    const layout = await readWorkspaceLayout(workspace.id).catch(() => null);
    const tabs: Record<string, string> = {};
    for (const tab of layout ? collectAllTabs(layout.root) : []) tabs[tab.id] = tab.name || tab.id;
    return {
      id: workspace.id,
      name: workspace.name,
      orchestratorTabId: workspace.orchestration?.enabled ? workspace.orchestration.orchestratorTabId : null,
      tabs,
    };
  }));
};

export const workspaceExists = async (workspaceId: string): Promise<boolean> =>
  (await getWorkspaces()).workspaces.some((workspace) => workspace.id === workspaceId);

/** The one spend answer for the CLI and the human route. Reads the index in memory; never parses a transcript. */
export const getSpendView = async (query: ISpendQuery, now = Date.now()): Promise<ISpendView> => {
  await loadSpendIndex();
  let bindings: Record<string, ISpendBindingRef> = {};
  let bindingError: string | null = null;
  try {
    bindings = await readSessionTabs();
  } catch (error) {
    if (!(error instanceof SessionTabsStoreError)) throw error;
    bindingError = `${error.message}; no usage is attributed to a tab`;
  }
  const index = spendIndexStatus();
  const error = [index.error, bindingError].filter(Boolean).join('; ');
  return buildSpendView({
    usage: spendIndexUsage(),
    bindings,
    workspaces: await loadWorkspaceRefs(),
    ...query,
    generatedAt: now,
    index: { ...index, ...(error ? { error } : {}) },
  });
};

/**
 * Tokens per UTC day for the burndown's workspace, gaps filled with 0. Absent
 * until a full index pass has run since boot: a partial count is never drawn.
 */
export const getSpendTokensByDay = async (workspaceId: string, from: string, now = Date.now()): Promise<ISpendTokensByDay[] | undefined> => {
  const to = utcDay(now);
  const start = from > to ? to : (rangeDays(from, to) > MAX_SPEND_RANGE_DAYS ? addUtcDays(to, -(MAX_SPEND_RANGE_DAYS - 1)) : from);
  const view = await getSpendView({ workspaceId, from: start, to, by: 'day' }, now);
  if (view.index.state !== 'ready') return undefined;
  const byDay = new Map(tokensByDay(view).map((row) => [row.day, row]));
  const days: ISpendTokensByDay[] = [];
  for (let day = start; day <= to; day = addUtcDays(day, 1)) {
    days.push(byDay.get(day) ?? { day, totalTokens: 0, sidechainTokens: 0 });
  }
  return days;
};

/** What session history and the layouts already know, so the store starts with every binding the server holds. */
export const seedSessionTabBindings = async (now = Date.now()): Promise<number> => {
  const sightings: ISessionTabSighting[] = [];
  for (const entry of await getSessionHistory().catch(() => [])) {
    if (!entry.agentSessionId || !entry.workspaceId || !entry.tabId) continue;
    sightings.push({ providerId: entry.providerId, sessionId: entry.agentSessionId, workspaceId: entry.workspaceId,
      tabId: entry.tabId, seenAt: entry.completedAt || entry.startedAt || now });
  }
  const { workspaces } = await getWorkspaces();
  for (const workspace of workspaces) {
    const layout = await readWorkspaceLayout(workspace.id).catch(() => null);
    for (const tab of layout ? collectAllTabs(layout.root) : []) {
      const provider = getProviderByPanelType(tab.panelType);
      const sessionId = provider?.readSessionId(tab);
      if (!provider || !sessionId) continue;
      sightings.push({ providerId: toSessionHistoryProvider(provider.id), sessionId, workspaceId: workspace.id, tabId: tab.id, seenAt: now });
    }
  }
  return seedSessionTabs(sightings, now);
};

export const startSpend = (): Promise<void> => startSpendIndexer({
  beforeFirstPass: async () => {
    try {
      const seeded = await seedSessionTabBindings();
      log.info(`session-tabs seeded with ${seeded} binding(s)`);
    } catch (error) {
      log.warn(`session-tabs seed failed: ${(error as Error).message}`);
    }
  },
});

export const stopSpend = (): Promise<void> => stopSpendIndexer();
