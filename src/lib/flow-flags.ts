// Derived bottleneck flags over a flow record (ADR-0026 decision 5). Pure and browser-safe: the
// human route, the CLI route, `flow show` and the flag tick read one answer from here, and the
// phone never derives a flag.
import { FLOW_STALE_MS, isFlowStale } from '@/lib/flow';
import type {
  IFlowDerived, IFlowDerivedFlag, IFlowHistoryRow, IFlowRecord, IFlowThresholds, TFlowRule,
} from '@/types/flow';

export const FLOW_CONFIG_KEYS: Record<keyof IFlowThresholds, string> = {
  windowMinutes: 'flow.window-minutes',
  lockBusyPercent: 'flow.lock-busy-percent',
  queueLength: 'flow.queue-length',
  oldestMinutes: 'flow.oldest-minutes',
};

export const DEFAULT_FLOW_THRESHOLDS: IFlowThresholds = {
  windowMinutes: 360,
  lockBusyPercent: 80,
  queueLength: 10,
  oldestMinutes: 240,
};

interface IThresholdRule {
  min: number;
  max: number;
  integer: boolean;
}

/** §4.10 ranges. A queue length counts items, so only it must be whole. */
export const FLOW_THRESHOLD_RULES: Record<keyof IFlowThresholds, IThresholdRule> = {
  windowMinutes: { min: 10, max: 10_080, integer: false },
  lockBusyPercent: { min: 1, max: 100, integer: false },
  queueLength: { min: 1, max: 10_000, integer: true },
  oldestMinutes: { min: 1, max: 10_080, integer: false },
};

export interface IFlowThresholdReading {
  value: number;
  /** Why the default was used for a set value; null when the value was used or nothing was set. */
  reason: string | null;
}

/** One `flow.*` value: a plain decimal (a whole number for the queue length) inside its range, else the default and why. */
export const parseFlowThreshold = (key: keyof IFlowThresholds, raw: string | null | undefined): IFlowThresholdReading => {
  const fallback = DEFAULT_FLOW_THRESHOLDS[key];
  if (raw === null || raw === undefined) return { value: fallback, reason: null };
  const rule = FLOW_THRESHOLD_RULES[key];
  const name = FLOW_CONFIG_KEYS[key];
  const text = raw.trim();
  const grammar = rule.integer ? /^\d+$/ : /^\d+(\.\d+)?$/;
  if (!grammar.test(text)) {
    return { value: fallback, reason: `${name} is ${JSON.stringify(raw)}, not ${rule.integer ? 'a whole number' : 'a number'}; default ${fallback}` };
  }
  const value = Number(text);
  if (value < rule.min || value > rule.max) {
    return { value: fallback, reason: `${name} is ${value}, outside ${rule.min}..${rule.max}; default ${fallback}` };
  }
  return { value, reason: null };
};

export const parseFlowThresholds = (
  raw: Partial<Record<keyof IFlowThresholds, string | null>>,
): { thresholds: IFlowThresholds; reasons: string[] } => {
  const keys = Object.keys(FLOW_CONFIG_KEYS) as Array<keyof IFlowThresholds>;
  const readings = keys.map((key) => [key, parseFlowThreshold(key, raw[key])] as const);
  return {
    thresholds: Object.fromEntries(readings.map(([key, reading]) => [key, reading.value])) as unknown as IFlowThresholds,
    reasons: readings.flatMap(([, reading]) => (reading.reason ? [reading.reason] : [])),
  };
};

const SEVERITY_ORDER: Record<IFlowDerivedFlag['severity'], number> = { block: 0, warn: 1 };

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `block` first, then `warn`, then by rule and subject in code-point order. */
export const sortFlowFlags = (flags: IFlowDerivedFlag[]): IFlowDerivedFlag[] => [...flags].sort((a, b) =>
  SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || compareText(a.rule, b.rule) || compareText(a.subject, b.subject));

export const flowDurationText = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
};

const flag = (rule: TFlowRule, subject: string, text: string, severity: IFlowDerivedFlag['severity'] = 'warn'): IFlowDerivedFlag =>
  ({ rule, subject, text, severity });

export interface ILockBusy {
  /** Busy time over known time; null when the known time is under half the window. */
  share: number | null;
  knownMinutes: number;
  /** Whole milliseconds: the threshold compare runs on these, never on the float share. */
  busyMs: number;
  knownMs: number;
}

/**
 * The time-weighted busy share of one lock over `[now − window, now]`. Each row's state holds from its
 * `at` to the next row's `at` (the newest row until `now`). An interval longer than the stale limit,
 * a negative one (the clock stepped back) and a row without this lock are unknown time, on neither
 * side, and no instant counts twice. The caller passes the full history: the newest row before the
 * window start holds the state at the window start.
 */
export const lockBusy = (history: IFlowHistoryRow[], lock: string, windowMinutes: number, now: number): ILockBusy => {
  const windowMs = windowMinutes * 60_000;
  const start = now - windowMs;
  let known = 0;
  let busy = 0;
  // After a step back, rows can cover time already counted; each instant counts once.
  let counted = start;
  history.forEach((row, index) => {
    const next = index + 1 < history.length ? history[index + 1].at : now;
    const end = Math.min(next, now);
    if (next <= row.at || next - row.at > FLOW_STALE_MS || !Object.hasOwn(row.locks, lock)) return;
    const from = Math.max(row.at, counted);
    if (end <= from) return;
    known += end - from;
    if (row.locks[lock] === true) busy += end - from;
    counted = end;
  });
  return { share: known * 2 < windowMs ? null : busy / known, knownMinutes: known / 60_000, busyMs: busy, knownMs: known };
};

/**
 * The `lock-busy` rule: a measured share is at least the percent. It compares in milliseconds, so an
 * exact hit (57 of 100 minutes at 57%) raises the flag although `0.57 * 100 < 57` in floating point.
 * The flag tick (ADR-0032) calls this compare too.
 */
export const lockBusyMeetsThreshold = (busy: Pick<ILockBusy, 'share' | 'busyMs' | 'knownMs'>, percent: number): boolean =>
  busy.share !== null && busy.busyMs * 100 >= percent * busy.knownMs;

// A served share is a correctly rounded busy/known of whole milliseconds, so a true percent never
// lies within this tolerance of an integer it does not reach.
const SHARE_EPSILON = 1e-9;

/** The shown percent, rounded down: a shown value never meets an integer threshold the rule did not meet. */
export const lockBusyPercentShown = (share: number): number => Math.floor(share * 100 + SHARE_EPSILON);

/**
 * The busy sentence after a lock's name, for every face (the derived flag text, the panel and
 * `flow show`, which mirrors it in `bin/cli.js`). It names the known time when that is less than
 * the window, since the share is over known time only.
 */
export const lockBusyPhrase = (share: number | null, knownMinutes: number, windowMinutes: number): string => {
  const window = flowDurationText(windowMinutes * 60_000);
  const known = flowDurationText(knownMinutes * 60_000);
  if (share === null) return `busy share unknown: ${known} known in the last ${window}`;
  const shown = `${lockBusyPercentShown(share)}%`;
  return Math.round(knownMinutes * 60_000) >= Math.round(windowMinutes * 60_000)
    ? `held ${shown} of the last ${window}`
    : `held ${shown} of ${known} known in the last ${window}`;
};

// Lock names are producer strings: the maps are built with Object.fromEntries, so a lock named
// `__proto__` is an own key like any other, never a prototype change.
const lockFlags = (record: IFlowRecord, thresholds: IFlowThresholds, now: number) => {
  const measured = record.snapshot.locks.map((lock) => ({ name: lock.name, ...lockBusy(record.history, lock.name, thresholds.windowMinutes, now) }));
  return {
    lockBusyShare: Object.fromEntries(measured.map((lock) => [lock.name, lock.share])) as Record<string, number | null>,
    lockKnownMinutes: Object.fromEntries(measured.map((lock) => [lock.name, lock.knownMinutes])) as Record<string, number>,
    insufficientHistory: measured.filter((lock) => lock.share === null).map((lock) => lock.name),
    flags: measured.flatMap((lock) => (lockBusyMeetsThreshold(lock, thresholds.lockBusyPercent)
      ? [flag('lock-busy', lock.name,
        `${lock.name} ${lockBusyPhrase(lock.share, lock.knownMinutes, thresholds.windowMinutes)} (threshold ${thresholds.lockBusyPercent}%)`)]
      : [])),
  };
};

const queueFlags = (record: IFlowRecord, thresholds: IFlowThresholds, now: number): IFlowDerivedFlag[] =>
  record.snapshot.queues.flatMap((queue) => {
    const length = queue.items.length;
    const flags: IFlowDerivedFlag[] = [];
    if (queue.capacity !== null && length >= queue.capacity) {
      flags.push(flag('queue-full', queue.name, `${queue.name} holds ${length} of capacity ${queue.capacity}`, 'block'));
    }
    if (length >= thresholds.queueLength) {
      flags.push(flag('queue-long', queue.name, `${queue.name} holds ${length} items (threshold ${thresholds.queueLength})`));
    }
    if (length > 0) {
      const age = now - Math.min(...queue.items.map((item) => item.since));
      if (age > thresholds.oldestMinutes * 60_000) {
        flags.push(flag('queue-old', queue.name,
          `${queue.name} oldest item waits ${flowDurationText(age)} (threshold ${flowDurationText(thresholds.oldestMinutes * 60_000)})`));
      }
    }
    return flags;
  });

const meterFlags = (record: IFlowRecord): IFlowDerivedFlag[] => record.snapshot.meters.flatMap((meter) => {
  if (meter.limit === null || meter.value <= meter.limit) return [];
  const unit = meter.unit ? ` ${meter.unit}` : '';
  return [flag('meter-over', meter.name, `${meter.name} ${meter.value}${unit} over its limit ${meter.limit}${unit}`)];
});

/**
 * The derived flags, sorted by severity. A stale record raises only `stale`: no other rule runs on
 * old data. The busy shares are measurements, served either way; on a stale record the time since
 * the last publish is unknown time.
 */
export const deriveFlowFlags = (record: IFlowRecord, thresholds: IFlowThresholds, now: number): IFlowDerived => {
  const locks = lockFlags(record, thresholds, now);
  const base = {
    lockBusyShare: locks.lockBusyShare,
    lockKnownMinutes: locks.lockKnownMinutes,
    insufficientHistory: locks.insufficientHistory,
    windowMinutes: thresholds.windowMinutes,
    thresholds,
  };
  if (isFlowStale(record.receivedAt, now)) {
    return { flags: [flag('stale', record.workspaceId, `no publish for ${flowDurationText(now - record.receivedAt)}`)], ...base };
  }
  return {
    flags: sortFlowFlags([...locks.flags, ...queueFlags(record, thresholds, now), ...meterFlags(record)]),
    ...base,
  };
};
