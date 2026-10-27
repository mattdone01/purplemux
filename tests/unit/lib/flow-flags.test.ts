import { describe, expect, it } from 'vitest';
import { selectFlowHistory } from '@/lib/flow';
import {
  DEFAULT_FLOW_THRESHOLDS, FLOW_CONFIG_KEYS, deriveFlowFlags, flowDurationText, lockBusy, lockBusyMeetsThreshold, lockBusyPercentShown,
  lockBusyPhrase, parseFlowThreshold, parseFlowThresholds, sortFlowFlags,
} from '@/lib/flow-flags';
import type { IFlowDerivedFlag, IFlowHistoryRow, IFlowItem, IFlowRecord, IFlowSnapshot } from '@/types/flow';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

const item = (id: string, ageMinutes: number, extra: Partial<IFlowItem> = {}): IFlowItem =>
  ({ id, label: null, since: NOW - ageMinutes * MIN, state: 'queued', pinned: false, holder: null, ...extra });

const snapshot = (overrides: Partial<IFlowSnapshot> = {}): IFlowSnapshot => ({
  schemaVersion: 1, generatedAt: NOW - MIN, source: 'v2-flow',
  queues: [{ name: 'landing', capacity: null, items: [item('a', 5)] }],
  locks: [{ name: 'landing', heldBy: null, since: null }],
  meters: [],
  flags: [],
  ...overrides,
});

const lockRow = (at: number, held: boolean | undefined, lock = 'landing'): IFlowHistoryRow =>
  ({ at, queues: {}, oldest: {}, locks: held === undefined ? {} : { [lock]: held }, meters: {} });

/** One row every `step` minutes from `fromMinutesAgo` down to `toMinutesAgo` (inclusive). */
const rows = (fromMinutesAgo: number, toMinutesAgo: number, step: number, held: (minutesAgo: number) => boolean | undefined) => {
  const out: IFlowHistoryRow[] = [];
  for (let ago = fromMinutesAgo; ago >= toMinutesAgo; ago -= step) out.push(lockRow(NOW - ago * MIN, held(ago)));
  return out;
};

const record = (overrides: Partial<IFlowRecord> = {}): IFlowRecord => ({
  workspaceId: 'ws-a', receivedAt: NOW - MIN, snapshot: snapshot(), history: rows(360, 0, 5, () => false), ...overrides,
});

const rulesOf = (flags: IFlowDerivedFlag[]) => flags.map((flag) => `${flag.severity} ${flag.rule} ${flag.subject}`);

describe('parseFlowThreshold', () => {
  it('reads an unset value as its default with no reason', () => {
    for (const key of Object.keys(FLOW_CONFIG_KEYS) as Array<keyof typeof FLOW_CONFIG_KEYS>) {
      expect(parseFlowThreshold(key, null)).toEqual({ value: DEFAULT_FLOW_THRESHOLDS[key], reason: null });
      expect(parseFlowThreshold(key, undefined)).toEqual({ value: DEFAULT_FLOW_THRESHOLDS[key], reason: null });
    }
    expect(DEFAULT_FLOW_THRESHOLDS).toEqual({ windowMinutes: 360, lockBusyPercent: 80, queueLength: 10, oldestMinutes: 240 });
    expect(FLOW_CONFIG_KEYS).toEqual({ windowMinutes: 'flow.window-minutes', lockBusyPercent: 'flow.lock-busy-percent',
      queueLength: 'flow.queue-length', oldestMinutes: 'flow.oldest-minutes' });
  });

  it('accepts each range edge and refuses one step outside it, naming the key and the default', () => {
    expect(parseFlowThreshold('windowMinutes', '10')).toEqual({ value: 10, reason: null });
    expect(parseFlowThreshold('windowMinutes', '10080')).toEqual({ value: 10_080, reason: null });
    expect(parseFlowThreshold('windowMinutes', '9')).toEqual({ value: 360, reason: 'flow.window-minutes is 9, outside 10..10080; default 360' });
    expect(parseFlowThreshold('windowMinutes', '10081').value).toBe(360);
    expect(parseFlowThreshold('lockBusyPercent', '1')).toEqual({ value: 1, reason: null });
    expect(parseFlowThreshold('lockBusyPercent', '100')).toEqual({ value: 100, reason: null });
    expect(parseFlowThreshold('lockBusyPercent', '0')).toEqual({ value: 80, reason: 'flow.lock-busy-percent is 0, outside 1..100; default 80' });
    expect(parseFlowThreshold('lockBusyPercent', '100.5').value).toBe(80);
    expect(parseFlowThreshold('queueLength', '1')).toEqual({ value: 1, reason: null });
    expect(parseFlowThreshold('queueLength', '10000')).toEqual({ value: 10_000, reason: null });
    expect(parseFlowThreshold('queueLength', '10001').value).toBe(10);
    expect(parseFlowThreshold('oldestMinutes', '1')).toEqual({ value: 1, reason: null });
    expect(parseFlowThreshold('oldestMinutes', '10080')).toEqual({ value: 10_080, reason: null });
    expect(parseFlowThreshold('oldestMinutes', '0').value).toBe(240);
  });

  it('reads a value that is not a plain number as the default, and a fraction only where a fraction means something', () => {
    expect(parseFlowThreshold('windowMinutes', 'six hours')).toEqual({ value: 360,
      reason: 'flow.window-minutes is "six hours", not a number; default 360' });
    expect(parseFlowThreshold('windowMinutes', '-20').value).toBe(360);
    expect(parseFlowThreshold('windowMinutes', '1e3').value).toBe(360);
    expect(parseFlowThreshold('windowMinutes', '')).toMatchObject({ value: 360, reason: expect.stringContaining('not a number') });
    expect(parseFlowThreshold('windowMinutes', ' 120 ')).toEqual({ value: 120, reason: null });
    expect(parseFlowThreshold('lockBusyPercent', '87.5')).toEqual({ value: 87.5, reason: null });
    expect(parseFlowThreshold('queueLength', '10.5')).toEqual({ value: 10,
      reason: 'flow.queue-length is "10.5", not a whole number; default 10' });
  });

  it('reads the four keys at once and lists every reason', () => {
    expect(parseFlowThresholds({ windowMinutes: '60', queueLength: 'x', oldestMinutes: null })).toEqual({
      thresholds: { windowMinutes: 60, lockBusyPercent: 80, queueLength: 10, oldestMinutes: 240 },
      reasons: ['flow.queue-length is "x", not a whole number; default 10'],
    });
  });
});

describe('deriveFlowFlags', () => {
  it('raises nothing for a fresh record under every threshold, and serves the thresholds it used', () => {
    expect(deriveFlowFlags(record(), DEFAULT_FLOW_THRESHOLDS, NOW)).toEqual({
      flags: [], lockBusyShare: { landing: 0 }, lockKnownMinutes: { landing: 360 }, insufficientHistory: [],
      windowMinutes: 360, thresholds: DEFAULT_FLOW_THRESHOLDS,
    });
  });

  it('raises queue-long at the queue length, not one below it', () => {
    const queue = (count: number) => record({ snapshot: snapshot({ queues: [{ name: 'landing', capacity: null,
      items: Array.from({ length: count }, (_, index) => item(`i${index}`, 1)) }] }) });
    expect(deriveFlowFlags(queue(9), DEFAULT_FLOW_THRESHOLDS, NOW).flags).toEqual([]);
    expect(deriveFlowFlags(queue(10), DEFAULT_FLOW_THRESHOLDS, NOW).flags).toEqual([
      { rule: 'queue-long', subject: 'landing', text: 'landing holds 10 items (threshold 10)', severity: 'warn' },
    ]);
    expect(deriveFlowFlags(queue(3), { ...DEFAULT_FLOW_THRESHOLDS, queueLength: 3 }, NOW).flags.map((flag) => flag.rule)).toEqual(['queue-long']);
  });

  it('raises queue-old, with the age, only past the oldest-minutes threshold', () => {
    const aged = (minutes: number) => record({ snapshot: snapshot({ queues: [{ name: 'landing', capacity: null,
      items: [item('young', 2), item('old', minutes)] }] }) });
    expect(deriveFlowFlags(aged(240), DEFAULT_FLOW_THRESHOLDS, NOW).flags).toEqual([]);
    expect(deriveFlowFlags(aged(67 * 60), DEFAULT_FLOW_THRESHOLDS, NOW).flags).toEqual([
      { rule: 'queue-old', subject: 'landing', text: 'landing oldest item waits 67 h (threshold 4 h)', severity: 'warn' },
    ]);
    const empty = record({ snapshot: snapshot({ queues: [{ name: 'landing', capacity: null, items: [] }] }) });
    expect(deriveFlowFlags(empty, { ...DEFAULT_FLOW_THRESHOLDS, oldestMinutes: 1 }, NOW).flags).toEqual([]);
  });

  it('raises queue-full as block at or over the capacity, and never for a queue without one', () => {
    const full = (count: number, capacity: number | null) => record({ snapshot: snapshot({ queues: [{ name: 'gate', capacity,
      items: Array.from({ length: count }, (_, index) => item(`g${index}`, 1)) }] }) });
    expect(deriveFlowFlags(full(3, 4), DEFAULT_FLOW_THRESHOLDS, NOW).flags).toEqual([]);
    expect(deriveFlowFlags(full(4, 4), DEFAULT_FLOW_THRESHOLDS, NOW).flags).toEqual([
      { rule: 'queue-full', subject: 'gate', text: 'gate holds 4 of capacity 4', severity: 'block' },
    ]);
    expect(deriveFlowFlags(full(5, 4), DEFAULT_FLOW_THRESHOLDS, NOW).flags[0]).toMatchObject({ rule: 'queue-full', severity: 'block' });
    expect(deriveFlowFlags(full(9, null), DEFAULT_FLOW_THRESHOLDS, NOW).flags).toEqual([]);
  });

  it('raises meter-over above the limit only, never at it or without one', () => {
    const meter = (value: number, limit: number | null, unit = 'USD') => record({ snapshot: snapshot({
      meters: [{ name: 'spend', value, unit, limit, windowMinutes: null }] }) });
    expect(deriveFlowFlags(meter(100, 100), DEFAULT_FLOW_THRESHOLDS, NOW).flags).toEqual([]);
    expect(deriveFlowFlags(meter(500, null), DEFAULT_FLOW_THRESHOLDS, NOW).flags).toEqual([]);
    expect(deriveFlowFlags(meter(120.5, 100), DEFAULT_FLOW_THRESHOLDS, NOW).flags).toEqual([
      { rule: 'meter-over', subject: 'spend', text: 'spend 120.5 USD over its limit 100 USD', severity: 'warn' },
    ]);
    expect(deriveFlowFlags(meter(6, 5, ''), DEFAULT_FLOW_THRESHOLDS, NOW).flags[0].text).toBe('spend 6 over its limit 5');
  });

  it('raises lock-busy from the time-weighted share, at the percent and not below it', () => {
    // 288 of 360 minutes held = exactly 80%.
    const busy = record({ snapshot: snapshot({ locks: [{ name: 'landing', heldBy: 'lane/a0', since: NOW - 10 * MIN }] }),
      history: rows(360, 0, 4, (ago) => ago > 72) });
    const derived = deriveFlowFlags(busy, DEFAULT_FLOW_THRESHOLDS, NOW);
    expect(derived.lockBusyShare.landing).toBeCloseTo(0.8, 10);
    expect(derived.flags).toEqual([
      { rule: 'lock-busy', subject: 'landing', text: 'landing held 80% of the last 6 h (threshold 80%)', severity: 'warn' },
    ]);
    expect(deriveFlowFlags(busy, { ...DEFAULT_FLOW_THRESHOLDS, lockBusyPercent: 81 }, NOW).flags).toEqual([]);
  });

  it('raises lock-busy on an exact hit that floating point would miss, and shows a rounded-down percent', () => {
    // k of `total` one-minute rows held: the share is exactly k / total.
    const exact = (k: number, total: number) => record({
      snapshot: snapshot({ locks: [{ name: 'landing', heldBy: 'x', since: NOW }] }),
      history: rows(total, 1, 1, (ago) => ago <= k),
    });
    for (const k of [29, 57, 58]) {
      // The float trap the millisecond compare avoids.
      expect((k / 100) * 100).toBeLessThan(k);
      const derived = deriveFlowFlags(exact(k, 100), { ...DEFAULT_FLOW_THRESHOLDS, windowMinutes: 100, lockBusyPercent: k }, NOW);
      expect(derived.lockBusyShare.landing).toBe(k / 100);
      expect(derived.flags, `k=${k}`).toEqual([{ rule: 'lock-busy', subject: 'landing', severity: 'warn',
        text: `landing held ${k}% of the last 1 h 40 min (threshold ${k}%)` }]);
    }
    // 797 of 1000 minutes at 80%: no flag, and the shown percent reads below the threshold.
    const under = deriveFlowFlags(exact(797, 1000), { ...DEFAULT_FLOW_THRESHOLDS, windowMinutes: 1000, lockBusyPercent: 80 }, NOW);
    expect(under.flags).toEqual([]);
    expect(lockBusyPercentShown(under.lockBusyShare.landing!)).toBe(79);
    expect(lockBusyPhrase(under.lockBusyShare.landing!, 1000, 1000)).toBe('held 79% of the last 16 h 40 min');
    expect(lockBusyMeetsThreshold({ share: 0.797, busyMs: 797, knownMs: 1000 }, 80)).toBe(false);
    expect(lockBusyMeetsThreshold({ share: 0.8, busyMs: 800, knownMs: 1000 }, 80)).toBe(true);
    expect(lockBusyMeetsThreshold({ share: null, busyMs: 0, knownMs: 0 }, 1)).toBe(false);
  });

  it('names the known time in the busy sentence when it is less than the window', () => {
    expect(lockBusyPhrase(0.92, 360, 360)).toBe('held 92% of the last 6 h');
    expect(lockBusyPhrase(1, 181, 360)).toBe('held 100% of 3 h 1 min known in the last 6 h');
    expect(lockBusyPhrase(null, 12.5, 360)).toBe('busy share unknown: 12 min known in the last 6 h');
    const partial = record({ snapshot: snapshot({ locks: [{ name: 'landing', heldBy: 'x', since: NOW }] }), history: rows(181, 0, 1, () => true) });
    expect(deriveFlowFlags(partial, DEFAULT_FLOW_THRESHOLDS, NOW).flags).toEqual([{ rule: 'lock-busy', subject: 'landing', severity: 'warn',
      text: 'landing held 100% of 3 h 1 min known in the last 6 h (threshold 80%)' }]);
  });

  it('weights each row by the time until the next row, not by the row count', () => {
    // Three of four rows say held, but they cover 3 of the 360 minutes: the free row holds for the rest.
    const history = [
      ...rows(360, 0, 6, () => false).filter((row) => row.at <= NOW - 4 * MIN),
      lockRow(NOW - 3 * MIN, true), lockRow(NOW - 2 * MIN, true), lockRow(NOW - MIN, true),
    ];
    const share = deriveFlowFlags(record({ history }), DEFAULT_FLOW_THRESHOLDS, NOW).lockBusyShare.landing!;
    expect(share).toBeCloseTo(3 / 360, 10);
  });

  it('counts an interval longer than 10 minutes on neither side', () => {
    // Free 360..191 min ago (the first hop is exactly 10 minutes, still known); one held row 191 min ago
    // with an 11-minute gap to the next row; held 180..0 min ago.
    const history = [lockRow(NOW - 360 * MIN, false), ...rows(355, 191, 5, () => false).slice(1), lockRow(NOW - 191 * MIN, true),
      ...rows(180, 0, 5, () => true)];
    const result = lockBusy(history, 'landing', 360, NOW);
    // 360 minus the 11-minute gap.
    expect(result.knownMinutes).toBeCloseTo(349, 10);
    expect(result.share).toBeCloseTo(180 / 349, 10);
  });

  it('serves a null share, lists the lock and raises nothing when known time is under half the window', () => {
    const thin = record({ snapshot: snapshot({ locks: [{ name: 'landing', heldBy: 'lane/a0', since: NOW - 170 * MIN }] }),
      history: rows(175, 0, 5, () => true) });
    const derived = deriveFlowFlags(thin, DEFAULT_FLOW_THRESHOLDS, NOW);
    expect(derived.lockBusyShare).toEqual({ landing: null });
    expect(derived.lockKnownMinutes.landing).toBeCloseTo(175, 10);
    expect(derived.insufficientHistory).toEqual(['landing']);
    expect(derived.flags).toEqual([]);
    // Exactly half the window is enough.
    expect(lockBusy(rows(180, 0, 5, () => true), 'landing', 360, NOW)).toMatchObject({ share: 1, knownMinutes: 180 });
    // No history at all.
    expect(lockBusy([], 'landing', 360, NOW)).toMatchObject({ share: null, knownMinutes: 0 });
  });

  it('reads the lock state at the window start from the newest row before it (the full record, not the window slice)', () => {
    // The window starts 360 min ago, in the middle of a hold that began 362 min ago.
    const history = [lockRow(NOW - 362 * MIN, true), ...rows(356, 0, 4, (ago) => ago > 74)];
    const full = record({ snapshot: snapshot({ locks: [{ name: 'landing', heldBy: 'x', since: NOW - 362 * MIN }] }), history });
    const derived = deriveFlowFlags(full, DEFAULT_FLOW_THRESHOLDS, NOW);
    // 4 carried-in minutes plus 356 → 72 min ago = 288 of 360 = 80%: the flag rises.
    expect(derived.lockKnownMinutes.landing).toBeCloseTo(360, 10);
    expect(derived.lockBusyShare.landing).toBeCloseTo(288 / 360, 10);
    expect(rulesOf(derived.flags)).toEqual(['warn lock-busy landing']);
    // The window slice drops the carry-in row: 284 of 356 minutes, under 80%, and no flag.
    const sliced = selectFlowHistory(full, 'window', NOW, 360);
    expect(sliced.history[0].at).toBe(NOW - 356 * MIN);
    const fromSlice = deriveFlowFlags(sliced, DEFAULT_FLOW_THRESHOLDS, NOW);
    expect(fromSlice.lockKnownMinutes.landing).toBeCloseTo(356, 10);
    expect(fromSlice.flags).toEqual([]);
  });

  it('treats a negative interval (the clock stepped back) and a row without the lock as unknown time', () => {
    const stepped = [...rows(360, 120, 5, () => false), lockRow(NOW - 118 * MIN, true), lockRow(NOW - 125 * MIN, true),
      ...rows(115, 0, 5, () => false)];
    const result = lockBusy(stepped, 'landing', 360, NOW);
    // 118 → 125 min ago steps back and counts nothing; 125 → 115 counts only the 3 minutes after 118.
    expect(result).toMatchObject({ share: 3 / 360, knownMinutes: 360, busyMs: 3 * MIN, knownMs: 360 * MIN });
    const missing = [...rows(360, 185, 5, () => false), ...rows(180, 0, 5, () => undefined)];
    expect(lockBusy(missing, 'landing', 360, NOW)).toMatchObject({ share: 0, knownMinutes: 180 });
    const future = [...rows(360, 5, 5, () => false), lockRow(NOW + 2 * MIN, true)];
    expect(lockBusy(future, 'landing', 360, NOW).knownMinutes).toBeCloseTo(360, 10);
  });

  it('raises only stale on a stale record and runs no other rule on old data', () => {
    const old = record({ receivedAt: NOW - 11 * MIN, snapshot: snapshot({
      queues: [{ name: 'landing', capacity: 2, items: Array.from({ length: 12 }, (_, index) => item(`i${index}`, 300)) }],
      meters: [{ name: 'spend', value: 9, unit: '', limit: 1, windowMinutes: null }],
    }), history: rows(371, 11, 5, () => true) });
    const derived = deriveFlowFlags(old, DEFAULT_FLOW_THRESHOLDS, NOW);
    expect(derived.flags).toEqual([{ rule: 'stale', subject: 'ws-a', text: 'no publish for 11 min', severity: 'warn' }]);
    // The share is still measured; the time since the last publish is unknown.
    expect(derived.lockKnownMinutes.landing).toBeCloseTo(349, 10);
    expect(derived.lockBusyShare.landing).toBe(1);
    expect(deriveFlowFlags(record({ receivedAt: NOW - 10 * MIN }), DEFAULT_FLOW_THRESHOLDS, NOW).flags).toEqual([]);
  });

  it('keeps a lock named __proto__ as an own key of every map', () => {
    const history = rows(360, 0, 5, () => undefined).map((entry) => JSON.parse(JSON.stringify(entry).replace('"locks":{}', '"locks":{"__proto__":true}')) as IFlowHistoryRow);
    const odd = record({ snapshot: snapshot({ locks: [{ name: '__proto__', heldBy: 'x', since: NOW }] }), history });
    const derived = deriveFlowFlags(odd, DEFAULT_FLOW_THRESHOLDS, NOW);
    expect(Object.hasOwn(derived.lockBusyShare, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(derived.lockBusyShare)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(derived)).lockBusyShare).toEqual(JSON.parse('{"__proto__":1}'));
    expect(rulesOf(derived.flags)).toEqual(['warn lock-busy __proto__']);
  });

  it('sorts block first, then warn, then by rule and subject', () => {
    const many = record({ snapshot: snapshot({
      queues: [
        { name: 'review', capacity: null, items: Array.from({ length: 10 }, (_, index) => item(`r${index}`, 300)) },
        { name: 'gate', capacity: 1, items: [item('g', 1)] },
        { name: 'beta', capacity: null, items: Array.from({ length: 10 }, (_, index) => item(`b${index}`, 1)) },
      ],
      meters: [{ name: 'spend', value: 2, unit: '', limit: 1, windowMinutes: null }],
      locks: [{ name: 'landing', heldBy: 'x', since: NOW }],
    }), history: rows(360, 0, 5, () => true) });
    expect(rulesOf(deriveFlowFlags(many, DEFAULT_FLOW_THRESHOLDS, NOW).flags)).toEqual([
      'block queue-full gate',
      'warn lock-busy landing',
      'warn meter-over spend',
      'warn queue-long beta',
      'warn queue-long review',
      'warn queue-old review',
    ]);
    const flag = (rule: IFlowDerivedFlag['rule'], subject: string, severity: IFlowDerivedFlag['severity']) => ({ rule, subject, text: '', severity });
    expect(rulesOf(sortFlowFlags([flag('stale', 'b', 'warn'), flag('queue-full', 'z', 'block'), flag('stale', 'a', 'warn')])))
      .toEqual(['block queue-full z', 'warn stale a', 'warn stale b']);
  });
});

describe('flowDurationText', () => {
  it('prints minutes under an hour, then hours and minutes', () => {
    expect(flowDurationText(-5)).toBe('0 min');
    expect(flowDurationText(59 * MIN + 59_000)).toBe('59 min');
    expect(flowDurationText(60 * MIN)).toBe('1 h');
    expect(flowDurationText(125 * MIN)).toBe('2 h 5 min');
  });
});
