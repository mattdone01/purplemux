import { alertFor, isOrchestratorTab } from '@/lib/alert-policy';
import type { TAlertDraft } from '@/lib/alert-policy';
import { DEFAULT_FLOW_THRESHOLDS, deriveFlowFlags } from '@/lib/flow-flags';
import { createLogger } from '@/lib/logger';
import type { IAlertContext } from '@/lib/notification-dispatcher';
import type { IFleetRow, IFleetView } from '@/types/fleet-status';
import type { IFlowRecord, IFlowThresholds } from '@/types/flow';
import type { IAlertFlag, TAlertProviderId } from '@/types/status';
import type { IWorkspace } from '@/types/terminal';

// Flag alerts (ADR-0032): a 60 s tick reads the fleet flags and the derived flow flags, and sends
// one `flag` alert when a flag is raised. Each flag names the reads it rests on: any of them failing
// keeps it from clearing, and the narrower set whose failure could make it false keeps it from
// raising. A flag first seen in a source with no good read since the start, or since the switch came
// back on, is recorded and sends nothing, so a deploy or a read that recovers replays nothing.

const log = createLogger('flag-alerts');

export const FLAG_ALERT_CONFIG_KEYS = {
  enabled: 'alerts.flags',
  repeatMinutes: 'alerts.flag-repeat-minutes',
} as const;

export const DEFAULT_FLAG_REPEAT_MINUTES = 60;
export const FLAG_ALERT_TICK_MS = 60_000;
export const FLAG_ALERT_SLOW_TICK_MS = 5_000;

const REPEAT_MIN = 1;
const REPEAT_MAX = 10_080;

/** Source ids: the reads a flag rests on. */
export const FLAG_SOURCES = {
  fleetView: 'fleet-view',
  smInbox: 'sm-inbox',
  waits: 'waits',
  layout: (workspaceId: string) => `layout:${workspaceId}`,
  tab: (workspaceId: string, tabId: string) => `tab:${workspaceId}/${tabId}`,
  flow: (workspaceId: string) => `flow:${workspaceId}`,
} as const;

export interface IRaisedFlag extends IAlertFlag {
  key: string;
  workspaceId: string;
  /** The flagged tab; null for a workspace-level flag, which goes to the workspace's orchestrator. */
  tabId: string | null;
  /** Every read the flag rule can depend on: while one fails, the flag is not cleared. */
  sources: string[];
  /** The reads whose failure could make this flag false: while one fails, it is not raised. */
  raiseSources: string[];
}

export interface IFlagScan {
  flags: IRaisedFlag[];
  /** Sources read well this tick. */
  read: Set<string>;
  /** Sources that could not be read this tick: a flag resting on one is unknown. */
  failed: Set<string>;
}

interface IFlagAlertEntry {
  flag: IRaisedFlag;
  /** null while the flag is not raised. */
  raisedAt: number | null;
  lastAlertAt: number | null;
}

export interface IFlagAlertState {
  /** Sources with a good read since the start or the last switch-on. */
  readSources: Set<string>;
  entries: Map<string, IFlagAlertEntry>;
}

export interface IFlagAlertConfig {
  enabled: boolean;
  repeatMinutes: number;
}

export const flagKey = (flag: Pick<IRaisedFlag, 'source' | 'workspaceId' | 'rule' | 'subject'>): string =>
  `${flag.source}:${flag.workspaceId}:${flag.rule}:${flag.subject}`;

const raised = (flag: Omit<IRaisedFlag, 'key'>): IRaisedFlag => ({ ...flag, key: flagKey(flag) });

export const createFlagAlertState = (): IFlagAlertState => ({ readSources: new Set(), entries: new Map() });

/**
 * `alerts.flags` is off only when it reads `off`. `alerts.flag-repeat-minutes` is a plain decimal
 * in 1..10080; any other value reads as the default, and `reason` says why.
 */
export const parseFlagAlertConfig = (
  enabledRaw: string | null,
  repeatRaw: string | null,
): { config: IFlagAlertConfig; reason: string | null } => {
  const enabled = enabledRaw?.trim() !== 'off';
  if (repeatRaw === null) return { config: { enabled, repeatMinutes: DEFAULT_FLAG_REPEAT_MINUTES }, reason: null };
  const text = repeatRaw.trim();
  const value = Number(text);
  if (!/^\d+(\.\d+)?$/.test(text) || value < REPEAT_MIN || value > REPEAT_MAX) {
    return {
      config: { enabled, repeatMinutes: DEFAULT_FLAG_REPEAT_MINUTES },
      reason: `${FLAG_ALERT_CONFIG_KEYS.repeatMinutes} is ${JSON.stringify(repeatRaw)}, not a number in ${REPEAT_MIN}..${REPEAT_MAX}; default ${DEFAULT_FLAG_REPEAT_MINUTES}`,
    };
  }
  return { config: { enabled, repeatMinutes: value }, reason: null };
};

/** Fleet view error scopes with no flag input. */
const FLAG_NEUTRAL_SCOPES = new Set(['leases', 'WIP cap']);

/**
 * The fleet view sources each error makes unreadable. A workspace's layout error carries its
 * `workspaceId`; an error with neither a workspace nor a known scope makes the whole view unknown.
 */
const fleetFailures = (view: IFleetView): Set<string> => {
  const failed = new Set<string>();
  for (const error of view.errors) {
    if (error.workspaceId !== undefined) failed.add(FLAG_SOURCES.layout(error.workspaceId));
    else if (error.scope === 'SM inbox') failed.add(FLAG_SOURCES.smInbox);
    else if (error.scope === 'watches' || error.scope === 'jobs') failed.add(FLAG_SOURCES.waits);
    else if (!FLAG_NEUTRAL_SCOPES.has(error.scope)) failed.add(FLAG_SOURCES.fleetView);
  }
  return failed;
};

const RULE_SOURCES: Record<string, string> = { unanswered: FLAG_SOURCES.smInbox, stall: FLAG_SOURCES.waits };

/**
 * Of a row flag's rule sources, the ones its present reason rests on. Only the idle STALL? needs the
 * registered waits (`fleet-status.ts` refuses it without them); only the inbox clause of an
 * UNANSWERED needs the SM inbox, and the row's inbox counts it.
 */
const rowRaiseSources = (row: IFleetRow, rule: string): string[] => {
  if (rule === 'stall' && (row.state === 'idle' || row.state === 'ready-for-review')) return [FLAG_SOURCES.waits];
  if (rule === 'unanswered' && (row.inbox?.unanswered ?? 0) > 0) return [FLAG_SOURCES.smInbox];
  return [];
};

/**
 * The fleet flags (ADR-0023) of one view. A tab flag's subject is the tab; an unattributed
 * UNANSWERED is workspace-level and its subject is the workspace. A null view is a failed read.
 */
export const fleetFlagScan = (view: IFleetView | null, workspaces: Array<Pick<IWorkspace, 'id'>>): IFlagScan => {
  if (!view) return { flags: [], read: new Set(), failed: new Set([FLAG_SOURCES.fleetView]) };
  const failed = fleetFailures(view);
  const ruleSource = (rule: string) => (RULE_SOURCES[rule] ? [RULE_SOURCES[rule]] : []);
  const flags: IRaisedFlag[] = [
    ...view.rows.flatMap((row) => row.flags.map((f) => {
      const base = [FLAG_SOURCES.fleetView, FLAG_SOURCES.layout(row.workspaceId), FLAG_SOURCES.tab(row.workspaceId, row.tabId)];
      return raised({
        source: 'fleet', workspaceId: row.workspaceId, rule: f.flag, subject: row.tabId, text: f.reason, tabId: row.tabId,
        sources: [...base, ...ruleSource(f.flag)],
        raiseSources: [...base, ...rowRaiseSources(row, f.flag)],
      });
    })),
    ...view.unattributed.flatMap((line) => line.flags.map((f) => {
      // The layout decides which items are unattributed: an unread layout makes its items look unattributed.
      const sources = [FLAG_SOURCES.fleetView, FLAG_SOURCES.layout(line.workspaceId), ...ruleSource(f.flag)];
      return raised({
        source: 'fleet', workspaceId: line.workspaceId, rule: f.flag, subject: line.workspaceId, text: f.reason, tabId: null,
        sources, raiseSources: sources,
      });
    })),
  ];
  for (const row of view.rows) if (row.state === 'unknown') failed.add(FLAG_SOURCES.tab(row.workspaceId, row.tabId));
  const read = new Set<string>();
  if (!failed.has(FLAG_SOURCES.fleetView)) {
    read.add(FLAG_SOURCES.fleetView);
    for (const source of [FLAG_SOURCES.smInbox, FLAG_SOURCES.waits]) if (!failed.has(source)) read.add(source);
    for (const w of workspaces) if (!failed.has(FLAG_SOURCES.layout(w.id))) read.add(FLAG_SOURCES.layout(w.id));
    for (const row of view.rows) if (row.state !== 'unknown') read.add(FLAG_SOURCES.tab(row.workspaceId, row.tabId));
  }
  return { flags, read, failed };
};

export type TFlowRead = { workspaceId: string; record: IFlowRecord | null } | { workspaceId: string; error: string };

/** The derived flow flags (ADR-0026) of every record read, each workspace-level. No record is a good read. */
export const flowFlagScan = (reads: TFlowRead[], thresholds: IFlowThresholds, now: number): IFlagScan => {
  const read = new Set<string>();
  const failed = new Set<string>();
  const flags: IRaisedFlag[] = [];
  for (const r of reads) {
    const source = FLAG_SOURCES.flow(r.workspaceId);
    if ('error' in r) {
      failed.add(source);
      continue;
    }
    read.add(source);
    if (!r.record) continue;
    for (const f of deriveFlowFlags(r.record, thresholds, now).flags) {
      flags.push(raised({
        source: 'flow', workspaceId: r.workspaceId, rule: f.rule, subject: f.subject, text: f.text, tabId: null, sources: [source], raiseSources: [source],
      }));
    }
  }
  return { flags, read, failed };
};

export const mergeFlagScans = (...scans: IFlagScan[]): IFlagScan => ({
  flags: scans.flatMap((scan) => scan.flags),
  read: new Set(scans.flatMap((scan) => [...scan.read])),
  failed: new Set(scans.flatMap((scan) => [...scan.failed])),
});

/**
 * Apply one scan to the raise-edge state and answer the flags to alert on: each one raised since
 * the previous scan, outside the repeat window of its last alert, whose every raise source read well
 * now and on an earlier tick. A raised flag absent now clears only when none of its sources failed.
 * The caller records a sent alert with `markFlagAlerted`.
 */
export const stepFlagAlerts = (state: IFlagAlertState, scan: IFlagScan, now: number, repeatMs: number): IRaisedFlag[] => {
  const failedIn = (sources: string[]) => sources.some((source) => scan.failed.has(source));
  const current = new Map(scan.flags.filter((flag) => !failedIn(flag.raiseSources)).map((flag) => [flag.key, flag]));
  for (const [key, entry] of state.entries) {
    if (entry.raisedAt !== null && !current.has(key) && !failedIn(entry.flag.sources)) entry.raisedAt = null;
  }
  const raises: IRaisedFlag[] = [];
  for (const [key, flag] of current) {
    const entry = state.entries.get(key);
    if (entry && entry.raisedAt !== null) {
      entry.flag = flag;
      continue;
    }
    const lastAlertAt = entry?.lastAlertAt ?? null;
    state.entries.set(key, { flag, raisedAt: now, lastAlertAt });
    const seen = flag.raiseSources.every((source) => state.readSources.has(source));
    if (seen && (lastAlertAt === null || now - lastAlertAt >= repeatMs)) raises.push(flag);
  }
  for (const source of scan.read) state.readSources.add(source);
  for (const [key, entry] of state.entries) {
    if (entry.raisedAt === null && (entry.lastAlertAt === null || now - entry.lastAlertAt >= repeatMs)) state.entries.delete(key);
  }
  return raises;
};

/**
 * Forget the sources of what is gone: a closed workspace's, and a tab its workspace's layout no
 * longer shows. A source the view could not speak for is kept.
 */
export const pruneFlagSources = (state: IFlagAlertState, workspaces: Array<Pick<IWorkspace, 'id'>>, scan: IFlagScan): void => {
  const ids = new Set(workspaces.map((w) => w.id));
  for (const source of state.readSources) {
    const match = /^(layout|flow|tab):([^/]+)(\/.+)?$/.exec(source);
    if (!match) continue;
    const [, kind, workspaceId] = match;
    if (!ids.has(workspaceId)) state.readSources.delete(source);
    else if (kind === 'tab' && scan.read.has(FLAG_SOURCES.layout(workspaceId)) && !scan.read.has(source) && !scan.failed.has(source)) {
      state.readSources.delete(source);
    }
  }
};

export const markFlagAlerted = (state: IFlagAlertState, key: string, at: number): void => {
  const entry = state.entries.get(key);
  if (entry) entry.lastAlertAt = at;
};

/** A raise whose target could not be checked stays a raise for the next tick. */
export const deferFlagRaise = (state: IFlagAlertState, key: string): void => {
  const entry = state.entries.get(key);
  if (entry) entry.raisedAt = null;
};

/** Switched off: forget what stands and what was read, so switching on starts from a fresh baseline. The repeat window is kept. */
export const pauseFlagAlerts = (state: IFlagAlertState): void => {
  state.readSources.clear();
  for (const entry of state.entries.values()) entry.raisedAt = null;
};

const toAlertProvider = (providerId: string | null): TAlertProviderId =>
  providerId === 'codex' || providerId === 'grok' ? providerId : 'claude';

export type TFlagTarget =
  | { ok: true; row: IFleetRow }
  | { ok: false; unknown: false; reason: 'no-orchestrator' | 'orchestrator-disabled' | 'tab-closed' }
  | { ok: false; unknown: true; reason: 'fleet-view-unreadable' | 'layout-unreadable' | 'tab-state-unknown' };

/**
 * The real tab an alert names (ADR-0032 decision 5): the flagged tab, or for a workspace-level
 * flag the workspace's enabled orchestrator. A tab the fleet view cannot vouch for this tick is
 * `unknown` (retry), never a missing target.
 */
export const flagAlertTarget = (flag: IRaisedFlag, workspace: IWorkspace | undefined, view: IFleetView | null): TFlagTarget => {
  let tabId = flag.tabId;
  if (tabId === null) {
    const orchestration = workspace?.orchestration;
    if (!orchestration?.orchestratorTabId) return { ok: false, unknown: false, reason: 'no-orchestrator' };
    if (!orchestration.enabled) return { ok: false, unknown: false, reason: 'orchestrator-disabled' };
    tabId = orchestration.orchestratorTabId;
  }
  if (!view) return { ok: false, unknown: true, reason: 'fleet-view-unreadable' };
  if (fleetFailures(view).has(FLAG_SOURCES.layout(flag.workspaceId))) return { ok: false, unknown: true, reason: 'layout-unreadable' };
  const row = view.rows.find((r) => r.workspaceId === flag.workspaceId && r.tabId === tabId);
  if (!row) return { ok: false, unknown: false, reason: 'tab-closed' };
  if (row.state === 'unknown') return { ok: false, unknown: true, reason: 'tab-state-unknown' };
  return { ok: true, row };
};

export const flagAlertDraft = (flag: IRaisedFlag, target: IFleetRow, workspace: IWorkspace | undefined, at: number): TAlertDraft =>
  alertFor({
    kind: 'flag',
    tabId: target.tabId,
    workspaceId: flag.workspaceId,
    workspaceName: workspace?.name ?? target.workspaceName,
    tabName: target.tabName,
    providerId: toAlertProvider(target.providerId),
    isOrchestrator: isOrchestratorTab({ id: target.tabId }, workspace),
    at,
    detail: flag.tabId ? `${target.tabName}: ${flag.text}` : flag.text,
    flag: { source: flag.source, rule: flag.rule, subject: flag.subject, text: flag.text },
  });

export interface IFlagAlertDeps {
  /** Throws when the fleet config cannot be read. */
  config: () => Promise<IFlagAlertConfig>;
  workspaces: () => Promise<IWorkspace[]>;
  fleetView: (now: number) => Promise<IFleetView>;
  flowThresholds: () => Promise<IFlowThresholds>;
  readFlow: (workspaceId: string) => Promise<IFlowRecord | null>;
  dispatch: (draft: TAlertDraft, ctx: IAlertContext) => Promise<unknown>;
}

export interface IFlagAlertTickResult {
  /** Why the tick read no flag; absent when it did. */
  skipped?: 'config-unreadable' | 'off' | 'workspaces-unreadable';
  /** No source had a good read before this tick: everything it saw was recorded, nothing sent. */
  baseline: boolean;
  sent: TAlertDraft[];
  /** Keys raised with no tab to name: no orchestrator, a disabled one, or a closed tab. */
  noTarget: string[];
  /** Keys whose tab this tick could not check; they are retried on the next tick. */
  targetUnknown: string[];
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One tick over `deps`. A failed read is logged and leaves the state it covers as it was. */
export const runFlagAlertTick = async (deps: IFlagAlertDeps, state: IFlagAlertState, now: number): Promise<IFlagAlertTickResult> => {
  const idle = (skipped: NonNullable<IFlagAlertTickResult['skipped']>): IFlagAlertTickResult =>
    ({ skipped, baseline: false, sent: [], noTarget: [], targetUnknown: [] });
  let config: IFlagAlertConfig;
  try {
    config = await deps.config();
  } catch (err) {
    log.warn(`flag alert tick skipped: fleet config unreadable (${errorText(err)})`);
    return idle('config-unreadable');
  }
  if (!config.enabled) {
    pauseFlagAlerts(state);
    return idle('off');
  }
  let workspaces: IWorkspace[];
  try {
    workspaces = await deps.workspaces();
  } catch (err) {
    log.warn(`flag alert tick skipped: workspaces unreadable (${errorText(err)})`);
    return idle('workspaces-unreadable');
  }
  const [view, thresholds, reads] = await Promise.all([
    deps.fleetView(now).catch((err) => {
      log.warn(`flag alert tick: fleet view unreadable (${errorText(err)})`);
      return null;
    }),
    deps.flowThresholds().catch(() => DEFAULT_FLOW_THRESHOLDS),
    Promise.all(workspaces.map(async (w): Promise<TFlowRead> => {
      try {
        return { workspaceId: w.id, record: await deps.readFlow(w.id) };
      } catch (err) {
        return { workspaceId: w.id, error: errorText(err) };
      }
    })),
  ]);
  const baseline = state.readSources.size === 0;
  const scan = mergeFlagScans(fleetFlagScan(view, workspaces), flowFlagScan(reads, thresholds, now));
  const raises = stepFlagAlerts(state, scan, now, config.repeatMinutes * 60_000);
  pruneFlagSources(state, workspaces, scan);
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const result: IFlagAlertTickResult = { baseline, sent: [], noTarget: [], targetUnknown: [] };
  for (const flag of raises) {
    const workspace = byId.get(flag.workspaceId);
    const target = flagAlertTarget(flag, workspace, view);
    if (!target.ok) {
      if (target.unknown) {
        deferFlagRaise(state, flag.key);
        result.targetUnknown.push(flag.key);
        log.warn({ key: flag.key, workspaceId: flag.workspaceId, reason: target.reason }, 'flag-alert-target-unknown');
      } else {
        result.noTarget.push(flag.key);
        log.warn({ key: flag.key, workspaceId: flag.workspaceId, reason: target.reason }, 'flag-alert-no-target');
      }
      continue;
    }
    const draft = flagAlertDraft(flag, target.row, workspace, now);
    try {
      await deps.dispatch(draft, { workspaceDir: workspace?.directories[0] ?? null });
      markFlagAlerted(state, flag.key, now);
      result.sent.push(draft);
    } catch (err) {
      log.warn(`flag alert dispatch failed for ${flag.key}: ${errorText(err)}`);
    }
  }
  return result;
};

const realDeps = (): IFlagAlertDeps => ({
  config: async () => {
    const { readFleetConfig, valueOf } = await import('@/lib/fleet-config-store');
    const state = await readFleetConfig();
    const { config, reason } = parseFlagAlertConfig(
      valueOf(state, FLAG_ALERT_CONFIG_KEYS.enabled)?.value ?? null,
      valueOf(state, FLAG_ALERT_CONFIG_KEYS.repeatMinutes)?.value ?? null,
    );
    if (g.__ptFlagAlertConfigLogged !== reason) {
      g.__ptFlagAlertConfigLogged = reason;
      if (reason) log.warn(reason);
    }
    return config;
  },
  workspaces: async () => (await (await import('@/lib/workspace-store')).getWorkspaces()).workspaces,
  fleetView: async (now) => (await import('@/lib/fleet-status-snapshot')).readFleetView(now),
  flowThresholds: async () => (await import('@/lib/flow-view')).readFlowThresholds(),
  readFlow: async (workspaceId) => (await import('@/lib/flow-store')).readFlow(workspaceId),
  dispatch: async (draft, ctx) => (await import('@/lib/notification-dispatcher')).getNotificationDispatcher().dispatch(draft, ctx),
});

interface IFlagAlertTimer {
  timer: ReturnType<typeof setInterval> | null;
  running: Promise<void> | null;
}

const g = globalThis as unknown as {
  __ptFlagAlertState?: IFlagAlertState;
  __ptFlagAlertTick?: IFlagAlertTimer;
  __ptFlagAlertConfigLogged?: string | null;
};
if (!g.__ptFlagAlertState) g.__ptFlagAlertState = createFlagAlertState();
if (!g.__ptFlagAlertTick) g.__ptFlagAlertTick = { timer: null, running: null };

export const flagAlertState = (): IFlagAlertState => g.__ptFlagAlertState!;

/**
 * One scheduled tick: skipped while the previous one still runs, and logged when it takes longer
 * than 5 s. `clock` is injectable for tests.
 */
export const runScheduledFlagAlertTick = async (
  deps: IFlagAlertDeps = realDeps(),
  clock: () => number = Date.now,
): Promise<IFlagAlertTickResult | null> => {
  const tick = g.__ptFlagAlertTick!;
  if (tick.running) {
    log.warn('flag alert tick skipped: the previous tick still runs');
    return null;
  }
  const started = clock();
  let result: IFlagAlertTickResult | null = null;
  const run = runFlagAlertTick(deps, flagAlertState(), started).then((r) => {
    result = r;
  }, (err) => {
    log.warn(`flag alert tick failed: ${errorText(err)}`);
  });
  tick.running = run;
  try {
    await run;
  } finally {
    tick.running = null;
    const durationMs = clock() - started;
    if (durationMs > FLAG_ALERT_SLOW_TICK_MS) log.warn({ durationMs }, `flag alert tick took ${durationMs} ms`);
  }
  return result;
};

/** Start the 60 s tick once per process (beside the Mission Control runtime). */
export const startFlagAlerts = (options: { intervalMs?: number; deps?: IFlagAlertDeps } = {}): void => {
  const tick = g.__ptFlagAlertTick!;
  if (tick.timer) return;
  const deps = options.deps ?? realDeps();
  tick.timer = setInterval(() => {
    void runScheduledFlagAlertTick(deps);
  }, options.intervalMs ?? FLAG_ALERT_TICK_MS);
  tick.timer.unref?.();
};

/** Stop the tick and wait for one in flight (`shutdownWs`). */
export const stopFlagAlerts = async (): Promise<void> => {
  const tick = g.__ptFlagAlertTick!;
  if (tick.timer) clearInterval(tick.timer);
  tick.timer = null;
  await tick.running?.catch(() => undefined);
};
