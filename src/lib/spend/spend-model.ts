import { calculateCost, formatModelDisplayName } from '@/lib/claude-tokens';
import type { ISpendIndexStatus, ISpendRow, ISpendTokensByDay, ISpendUsage, ISpendView, TSpendBy, TSpendProvider } from '@/types/spend';

export const GLOBAL_WORKSPACE_KEY = 'global';
export const UNATTRIBUTED_KEY = 'unattributed';
export const MAX_SPEND_RANGE_DAYS = 92;

export interface ISpendBindingRef {
  workspaceId: string;
  tabId: string;
}

export interface ISpendWorkspaceRef {
  id: string;
  name: string;
  /** The enabled orchestrator now; null when orchestration is off. */
  orchestratorTabId: string | null;
  /** Tab id → display name for every tab in the layout now. */
  tabs: Record<string, string>;
}

export interface ISpendModelInput {
  usage: ISpendUsage[];
  /** Keyed `<provider>:<sessionId>` (session-tabs.json). */
  bindings: Record<string, ISpendBindingRef>;
  workspaces: ISpendWorkspaceRef[];
  workspaceId: string | 'all';
  from: string;
  to: string;
  by: TSpendBy;
  generatedAt: number;
  index: ISpendIndexStatus;
}

interface IAccumulator {
  key: string;
  label: string;
  providers: Set<TSpendProvider>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sidechainTokens: number;
  costUsd: number;
  priced: boolean;
  unpricedTokens: number;
}

interface IResolvedUsage {
  usage: ISpendUsage;
  workspaceId: string | null;
  tabId: string | null;
}

const ROLE_LABELS: Record<string, string> = { orchestrator: 'Orchestrator', other: 'Other tabs' };
const UNATTRIBUTED_LABELS: Partial<Record<TSpendBy, string>> = {
  tab: 'Not bound to a tab',
  role: 'Not bound to a tab',
  workspace: 'Workspace not known',
};

export const usageTokens = (usage: ISpendUsage): number =>
  usage.input + usage.output + usage.cacheRead + usage.cacheCreation;

const usageCost = (usage: ISpendUsage): number | null => {
  if (usage.providerId !== 'claude') return usage.costUsd ?? null;
  return calculateCost(usage.model, usage.input, usage.output, usage.cacheCreation5m, usage.cacheCreation1h, usage.cacheRead);
};

const emptyAccumulator = (key: string, label: string): IAccumulator => ({
  key, label, providers: new Set(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  sidechainTokens: 0, costUsd: 0, priced: false, unpricedTokens: 0,
});

const add = (acc: IAccumulator, usage: ISpendUsage): void => {
  const tokens = usageTokens(usage);
  acc.providers.add(usage.providerId);
  acc.inputTokens += usage.input;
  acc.outputTokens += usage.output;
  acc.cacheReadTokens += usage.cacheRead;
  acc.cacheCreationTokens += usage.cacheCreation;
  if (usage.sidechain) acc.sidechainTokens += tokens;
  const cost = usageCost(usage);
  if (cost === null) {
    acc.unpricedTokens += tokens;
  } else {
    acc.costUsd += cost;
    acc.priced = true;
  }
};

const toRow = (acc: IAccumulator): ISpendRow => ({
  key: acc.key,
  label: acc.label,
  providerId: acc.providers.size === 1 ? [...acc.providers][0] : null,
  inputTokens: acc.inputTokens,
  outputTokens: acc.outputTokens,
  cacheReadTokens: acc.cacheReadTokens,
  cacheCreationTokens: acc.cacheCreationTokens,
  totalTokens: acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheCreationTokens,
  sidechainTokens: acc.sidechainTokens,
  costUsd: acc.priced ? acc.costUsd : null,
  unpricedTokens: acc.unpricedTokens,
});

/**
 * The workspace comes from where the transcript lives when that names one; the
 * tab only from a binding in that same workspace. A session no binding names
 * stays unattributed: never guessed from a tab name, never dropped (ADR-0030).
 */
const resolve = (usage: ISpendUsage, bindings: Record<string, ISpendBindingRef>): IResolvedUsage => {
  const key = `${usage.providerId}:${usage.sessionId}`;
  const binding = Object.hasOwn(bindings, key) ? bindings[key] : null;
  const workspaceId = usage.workspaceId ?? binding?.workspaceId ?? null;
  const tabId = binding && binding.workspaceId === workspaceId ? binding.tabId : null;
  return { usage, workspaceId, tabId };
};

const keyFor = (
  resolved: IResolvedUsage,
  by: TSpendBy,
  workspaces: Map<string, ISpendWorkspaceRef>,
): string | null => {
  switch (by) {
    case 'day': return resolved.usage.day;
    case 'model': return resolved.usage.model;
    case 'workspace': return resolved.workspaceId;
    case 'tab': return resolved.tabId;
    case 'role': {
      if (!resolved.tabId) return null;
      const orchestrator = resolved.workspaceId ? workspaces.get(resolved.workspaceId)?.orchestratorTabId : null;
      return orchestrator === resolved.tabId ? 'orchestrator' : 'other';
    }
  }
};

const labelFor = (
  key: string,
  by: TSpendBy,
  resolved: IResolvedUsage,
  workspaces: Map<string, ISpendWorkspaceRef>,
): string => {
  switch (by) {
    case 'day': return key;
    case 'model': return resolved.usage.providerId === 'claude' ? formatModelDisplayName(key) : key;
    case 'role': return ROLE_LABELS[key] ?? key;
    case 'workspace':
      if (key === GLOBAL_WORKSPACE_KEY) return 'Outside every workspace';
      return workspaces.get(key)?.name ?? `${key} (removed)`;
    case 'tab': {
      const workspace = resolved.workspaceId ? workspaces.get(resolved.workspaceId) : undefined;
      const name = workspace && Object.hasOwn(workspace.tabs, key) ? workspace.tabs[key] : null;
      return name ?? `${key} (closed)`;
    }
  }
};

const compareRows = (by: TSpendBy) => (a: ISpendRow, b: ISpendRow): number => {
  if (by === 'day') return a.key.localeCompare(b.key);
  return (b.totalTokens - a.totalTokens) || a.key.localeCompare(b.key);
};

export const isUtcDay = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addUtcDays = (day: string, days: number): string =>
  utcDay(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000);

/** The oldest UTC day spend serves: today − 91 (92 days, ADR-0030 §4 Retention). */
export const spendFloor = (now: number): string => addUtcDays(utcDay(now), -(MAX_SPEND_RANGE_DAYS - 1));

/** Inclusive length of a UTC day range. */
export const rangeDays = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** Rows in, view out. Invariant per `by` and per token field: sum(rows) + unattributed = totals. */
export const buildSpendView = (input: ISpendModelInput): ISpendView => {
  const workspaces = new Map(input.workspaces.map((workspace) => [workspace.id, workspace]));
  const totals = emptyAccumulator('total', 'Total');
  const unattributed = emptyAccumulator(UNATTRIBUTED_KEY, UNATTRIBUTED_LABELS[input.by] ?? 'Not attributed');
  const rows = new Map<string, IAccumulator>();
  let unattributedCount = 0;

  for (const usage of input.usage) {
    if (usage.day < input.from || usage.day > input.to) continue;
    const resolved = resolve(usage, input.bindings);
    if (input.workspaceId !== 'all' && resolved.workspaceId !== input.workspaceId) continue;
    add(totals, usage);
    const key = keyFor(resolved, input.by, workspaces);
    if (key === null) {
      add(unattributed, usage);
      unattributedCount += 1;
      continue;
    }
    let row = rows.get(key);
    if (!row) {
      row = emptyAccumulator(key, labelFor(key, input.by, resolved, workspaces));
      rows.set(key, row);
    }
    add(row, usage);
  }

  return {
    workspaceId: input.workspaceId,
    from: input.from,
    to: input.to,
    by: input.by,
    generatedAt: input.generatedAt,
    totals: toRow(totals),
    rows: [...rows.values()].map(toRow).sort(compareRows(input.by)),
    unattributed: unattributedCount > 0 ? toRow(unattributed) : null,
    ...(input.by === 'role' ? { roleBasis: 'current-orchestrator' as const } : {}),
    dayBasis: { claude: 'message', codex: 'session-start', grok: 'session-start' },
    index: input.index,
  };
};

/** Per-day tokens for one workspace, oldest first (the burndown's second axis). */
export const tokensByDay = (view: ISpendView): ISpendTokensByDay[] =>
  view.rows.map((row) => ({ day: row.key, totalTokens: row.totalTokens, sidechainTokens: row.sidechainTokens }));
