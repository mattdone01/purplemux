import { describe, expect, it } from 'vitest';
import {
  FLOW_STALE_MS,
  MAX_FLOW_BYTES,
  MAX_FLOW_HISTORY,
  MAX_FLOW_RECORD_BYTES,
  appendFlowHistory,
  flowHistoryRow,
  flowRecordBytes,
  isFlowStale,
  parseFlowHistoryMode,
  parseFlowRecord,
  parseFlowSnapshot,
  selectFlowHistory,
} from '@/lib/flow';
import type { IFlowHistoryRow, IFlowRecord, IFlowSnapshot } from '@/types/flow';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const MIN = 60_000;

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'lane/a0', label: 'A0 spine', since: NOW - 67 * 60 * MIN, state: 'queued', pinned: false, holder: null, ...overrides,
});
const queue = (overrides: Record<string, unknown> = {}) => ({
  name: 'landing', capacity: 20, items: [item(), item({ id: 'lane/b1', since: NOW - 5 * MIN, state: 'active', holder: 'tab-x' })],
  ...overrides,
});
const lock = (overrides: Record<string, unknown> = {}) => ({ name: 'landing', heldBy: 'lane/a0', since: NOW - 30 * MIN, ...overrides });
const meter = (overrides: Record<string, unknown> = {}) => ({
  name: 'gate-slots', value: 4, unit: 'slots', limit: 5, windowMinutes: null, ...overrides,
});
const flag = (overrides: Record<string, unknown> = {}) => ({ text: 'main is red', severity: 'block', ...overrides });
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, generatedAt: NOW - MIN, source: 'v2-flow', queues: [queue()], locks: [lock()], meters: [meter()],
  flags: [flag()], ...overrides,
});

const error = (raw: unknown): string => {
  const result = parseFlowSnapshot(raw, NOW);
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
};

const parsed = (raw: unknown = snapshot()): IFlowSnapshot => {
  const result = parseFlowSnapshot(raw, NOW);
  if (!result.ok) throw new Error(result.error);
  return result.snapshot;
};

const many = <T>(count: number, make: (index: number) => T): T[] => Array.from({ length: count }, (_, index) => make(index));

describe('parseFlowSnapshot', () => {
  it('accepts the contract shape unchanged', () => {
    expect(parsed()).toEqual(snapshot());
  });

  it('accepts the nullable fields and the empty lists', () => {
    const body = snapshot({
      queues: [queue({ capacity: null, items: [item({ label: null, holder: 'h'.repeat(128), state: 'held', pinned: true })] })],
      locks: [lock({ heldBy: null, since: null }), lock({ name: 'deploy', since: null })],
      meters: [meter({ limit: null, windowMinutes: 10_080, value: -2.5, unit: '' })],
      flags: [],
    });
    expect(parsed(body)).toEqual(body);
    expect(parsed(snapshot({ queues: [], locks: [], meters: [], flags: [] }))).toMatchObject({ queues: [], locks: [] });
  });

  it('refuses a body that is not an object', () => {
    expect(error(null)).toBe('body: saw null, expected a flow snapshot object');
    expect(error([])).toMatch(/^body: /);
    expect(error('x')).toMatch(/^body: /);
  });

  it('refuses an unknown key at every level, naming the key', () => {
    expect(error({ ...snapshot(), history: [] })).toBe('history: saw an unknown key, expected only schemaVersion, generatedAt, source, queues, locks, meters, flags');
    expect(error(snapshot({ queues: [{ ...queue(), nmae: 'x' }] }))).toBe('queues[0].nmae: saw an unknown key, expected only name, capacity, items');
    expect(error(snapshot({ queues: [queue({ items: [{ ...item(), owner: 'x' }] })] })))
      .toBe('queues[0].items[0].owner: saw an unknown key, expected only id, label, since, state, pinned, holder');
    expect(error(snapshot({ locks: [{ ...lock(), ttl: 1 }] }))).toMatch(/^locks\[0\]\.ttl: saw an unknown key/);
    expect(error(snapshot({ meters: [{ ...meter(), max: 1 }] }))).toMatch(/^meters\[0\]\.max: saw an unknown key/);
    expect(error(snapshot({ flags: [{ ...flag(), id: 1 }] }))).toMatch(/^flags\[0\]\.id: saw an unknown key/);
  });

  it('refuses a missing key', () => {
    const { source: _source, ...body } = snapshot();
    expect(error(body)).toBe('source: saw nothing, expected a non-blank string of at most 64 characters');
  });

  it('refuses a schemaVersion other than 1', () => {
    expect(error(snapshot({ schemaVersion: 2 }))).toBe('schemaVersion: saw 2, expected 1');
  });

  it('refuses an unknown item state', () => {
    expect(error(snapshot({ queues: [queue({ items: [item({ state: 'waiting' })] })] })))
      .toBe('queues[0].items[0].state: saw "waiting", expected one of queued, active, held');
  });

  it('refuses an unknown flag severity', () => {
    expect(error(snapshot({ flags: [flag({ severity: 'error' })] }))).toBe('flags[0].severity: saw "error", expected one of info, warn, block');
  });

  it('refuses more entries than each list allows', () => {
    expect(error(snapshot({ queues: many(21, (index) => queue({ name: `q${index}`, items: [] })) })))
      .toBe('queues: saw 21 entries, expected at most 20');
    expect(error(snapshot({ queues: [queue({ items: many(501, (index) => item({ id: `i${index}` })) })] })))
      .toBe('queues[0].items: saw 501 entries, expected at most 500');
    expect(error(snapshot({ locks: many(21, (index) => lock({ name: `l${index}` })) }))).toBe('locks: saw 21 entries, expected at most 20');
    expect(error(snapshot({ meters: many(51, (index) => meter({ name: `m${index}` })) }))).toBe('meters: saw 51 entries, expected at most 50');
    expect(error(snapshot({ flags: many(21, () => flag()) }))).toBe('flags: saw 21 entries, expected at most 20');
  });

  it('accepts each list at its limit', () => {
    const body = snapshot({
      queues: many(20, (index) => queue({ name: `q${index}`, items: index ? [] : many(500, (n) => item({ id: `i${n}` })) })),
      locks: many(20, (index) => lock({ name: `l${index}` })),
      meters: many(50, (index) => meter({ name: `m${index}` })),
      flags: many(20, () => flag()),
    });
    expect(parseFlowSnapshot(body, NOW).ok).toBe(true);
  });

  it('refuses a time more than 5 minutes after the receive time', () => {
    const late = NOW + 5 * MIN + 1;
    expect(error(snapshot({ queues: [queue({ items: [item({ since: late })] })] })))
      .toBe(`queues[0].items[0].since: saw ${late}, expected a time in Unix ms at most 5 min after the server clock ${NOW}`);
    expect(error(snapshot({ generatedAt: late }))).toMatch(/^generatedAt: saw \d+, expected a time in Unix ms at most 5 min/);
    expect(error(snapshot({ locks: [lock({ since: late })] }))).toMatch(/^locks\[0\]\.since: /);
    expect(parseFlowSnapshot(snapshot({ generatedAt: NOW + 5 * MIN }), NOW).ok).toBe(true);
  });

  it('refuses a time that is not a non-negative integer', () => {
    expect(error(snapshot({ generatedAt: '2026-10-26' }))).toMatch(/^generatedAt: saw "2026-10-26", expected a time in Unix ms/);
    expect(error(snapshot({ generatedAt: -1 }))).toMatch(/^generatedAt: saw -1/);
    expect(error(snapshot({ generatedAt: 1.5 }))).toMatch(/^generatedAt: saw 1.5/);
  });

  it('refuses duplicate names and duplicate item ids', () => {
    expect(error(snapshot({ queues: [queue({ items: [] }), queue({ items: [] })] })))
      .toBe('queues[1].name: saw "landing", expected a name no other queue holds');
    expect(error(snapshot({ queues: [queue({ items: [item(), item()] })] })))
      .toBe('queues[0].items[1].id: saw "lane/a0", expected an id no other item of the queue holds');
    expect(error(snapshot({ locks: [lock(), lock()] }))).toBe('locks[1].name: saw "landing", expected a name no other lock holds');
    expect(error(snapshot({ meters: [meter(), meter()] }))).toBe('meters[1].name: saw "gate-slots", expected a name no other meter holds');
  });

  it('lets two queues hold the same item id', () => {
    expect(parseFlowSnapshot(snapshot({ queues: [queue(), queue({ name: 'review' })] }), NOW).ok).toBe(true);
  });

  it('refuses a string outside its length', () => {
    expect(error(snapshot({ queues: [queue({ items: [item({ id: 'x'.repeat(129) })] })] })))
      .toBe(`queues[0].items[0].id: saw "${'x'.repeat(58)}…, expected a non-blank string of at most 128 characters`);
    expect(error(snapshot({ queues: [queue({ items: [item({ id: '' })] })] }))).toMatch(/^queues\[0\]\.items\[0\]\.id: saw ""/);
    expect(error(snapshot({ source: '   ' }))).toMatch(/^source: saw "   ", expected a non-blank string of at most 64/);
    expect(error(snapshot({ source: 's'.repeat(65) }))).toMatch(/^source: /);
    expect(error(snapshot({ queues: [queue({ name: 'q'.repeat(65) })] }))).toMatch(/^queues\[0\]\.name: /);
    expect(error(snapshot({ queues: [queue({ items: [item({ label: 'l'.repeat(121) })] })] })))
      .toMatch(/^queues\[0\]\.items\[0\]\.label: .*expected null or a string of at most 120 characters$/);
    expect(error(snapshot({ queues: [queue({ items: [item({ holder: 'h'.repeat(129) })] })] }))).toMatch(/\.holder: /);
    expect(error(snapshot({ locks: [lock({ heldBy: 'h'.repeat(129) })] }))).toMatch(/^locks\[0\]\.heldBy: /);
    expect(error(snapshot({ meters: [meter({ unit: 'u'.repeat(17) })] })))
      .toMatch(/^meters\[0\]\.unit: .*expected a string of at most 16 characters$/);
    expect(error(snapshot({ flags: [flag({ text: '' })] }))).toMatch(/^flags\[0\]\.text: .*expected a non-blank string of at most 200/);
    expect(error(snapshot({ flags: [flag({ text: 't'.repeat(201) })] }))).toMatch(/^flags\[0\]\.text: /);
  });

  it('refuses a control or format character in every producer string (newline, ESC, bidi override)', () => {
    expect(error(snapshot({ source: 'v2\nflow' }))).toBe('source: saw "v2\\nflow", expected no control or format character');
    expect(error(snapshot({ queues: [queue({ items: [item({ label: '\u001b[31mred' })] })] })))
      .toBe('queues[0].items[0].label: saw "\\u001b[31mred", expected no control character and no bidi control');
    expect(error(snapshot({ flags: [flag({ text: 'ok ‮' })] }))).toBe('flags[0].text: saw "ok \\u{202E}", expected no control character and no bidi control');
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [snapshot({ queues: [queue({ name: 'q\n' })] }), /^queues\[0\]\.name: /],
      [snapshot({ queues: [queue({ items: [item({ id: 'a\tb' })] })] }), /^queues\[0\]\.items\[0\]\.id: /],
      [snapshot({ queues: [queue({ items: [item({ holder: 'tab\u0007' })] })] }), /^queues\[0\]\.items\[0\]\.holder: /],
      [snapshot({ locks: [lock({ name: 'l\r' })] }), /^locks\[0\]\.name: /],
      [snapshot({ locks: [lock({ heldBy: 'lane\u001b' })] }), /^locks\[0\]\.heldBy: /],
      [snapshot({ meters: [meter({ name: 'm​' })] }), /^meters\[0\]\.name: /],
      [snapshot({ meters: [meter({ unit: 's\n' })] }), /^meters\[0\]\.unit: /],
    ];
    for (const [body, field] of cases) {
      expect(error(body)).toMatch(field);
      expect(error(body)).toMatch(/expected no control or format character$/);
    }
    expect(parseFlowSnapshot(snapshot({ source: 'v2-flow — café ✓' }), NOW).ok).toBe(true);
  });

  it('accepts the format characters of legitimate prose in a label and a flag text', () => {
    for (const prose of ['👩‍💻 review', 'می‌خواهم', '🏴󠁧󠁢󠁳󠁣󠁴󠁿 deploy', 'inter­national']) {
      const body = snapshot({ queues: [queue({ items: [item({ label: prose })] })], flags: [flag({ text: prose })] });
      expect(parsed(body)).toEqual(body);
    }
  });

  it('refuses every bidi control in prose and every format character in an identifier', () => {
    for (const bidi of ['؜', '‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩']) {
      expect(error(snapshot({ queues: [queue({ items: [item({ label: `a${bidi}b` })] })] })))
        .toMatch(/^queues\[0\]\.items\[0\]\.label: .*expected no control character and no bidi control$/);
    }
    expect(error(snapshot({ queues: [queue({ name: 'land‍ing' })] })))
      .toBe('queues[0].name: saw "land\\u{200D}ing", expected no control or format character');
    for (const format of ['­', '‌', '‍', '\u{e0067}']) {
      expect(error(snapshot({ source: `v2${format}flow` }))).toMatch(/^source: .*expected no control or format character$/);
      expect(error(snapshot({ locks: [lock({ heldBy: `lane${format}a0` })] }))).toMatch(/^locks\[0\]\.heldBy: /);
    }
  });

  it('echoes no raw format or bidi character in a refusal, and never splits a code point', () => {
    const message = error(snapshot({ queues: [queue({ items: [item({ label: 'evil‮exe.txt' })] })] }));
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(message).toContain('\\u{202E}');
    const long = error(snapshot({ source: '👩'.repeat(70) }));
    expect(long).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(long).toMatch(/^source: saw "👩+…, expected a non-blank string of at most 64 characters$/u);
  });

  it('echoes an unknown key escaped, never with its raw control or bidi characters', () => {
    const message = error({ ...snapshot(), 'k\u202E\u001b[31m': 1 });
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(message).toMatch(/^k\\u\{202E\}\\u\{1B\}\[31m: saw an unknown key/);
  });

  it('refuses a blank heldBy: a free lock says null', () => {
    expect(error(snapshot({ locks: [lock({ heldBy: '' })] })))
      .toBe('locks[0].heldBy: saw "", expected null for a free lock, or a non-blank string of at most 128 characters');
    expect(error(snapshot({ locks: [lock({ heldBy: '   ' })] }))).toMatch(/^locks\[0\]\.heldBy: saw "   "/);
  });

  it('refuses a capacity outside 1..10000 and a pinned that is not a boolean', () => {
    expect(error(snapshot({ queues: [queue({ capacity: 0 })] }))).toBe('queues[0].capacity: saw 0, expected null or an integer from 1 to 10000');
    expect(error(snapshot({ queues: [queue({ capacity: 10_001 })] }))).toMatch(/^queues\[0\]\.capacity: saw 10001/);
    expect(error(snapshot({ queues: [queue({ capacity: 2.5 })] }))).toMatch(/^queues\[0\]\.capacity: saw 2.5/);
    expect(error(snapshot({ queues: [queue({ items: [item({ pinned: 'no' })] })] })))
      .toBe('queues[0].items[0].pinned: saw "no", expected true or false');
  });

  it('refuses a free lock that states a since', () => {
    expect(error(snapshot({ locks: [lock({ heldBy: null })] })))
      .toBe(`locks[0].since: saw ${NOW - 30 * MIN}, expected null for a free lock (heldBy null)`);
  });

  it('refuses a meter value or limit that is not finite and a window outside 1..10080', () => {
    expect(error(snapshot({ meters: [meter({ value: '4' })] }))).toBe('meters[0].value: saw "4", expected a finite number');
    expect(error(snapshot({ meters: [meter({ limit: Number.NaN })] }))).toMatch(/^meters\[0\]\.limit: .*expected null or a finite number$/);
    expect(error(snapshot({ meters: [meter({ windowMinutes: 0 })] })))
      .toBe('meters[0].windowMinutes: saw 0, expected null or an integer from 1 to 10080');
    expect(error(snapshot({ meters: [meter({ windowMinutes: 10_081 })] }))).toMatch(/windowMinutes: saw 10081/);
  });

  it('refuses a list that is not an array and an entry that is not an object', () => {
    expect(error(snapshot({ queues: {} }))).toBe('queues: saw {}, expected an array');
    expect(error(snapshot({ locks: [null] }))).toBe('locks[0]: saw null, expected an object');
  });
});

describe('flowHistoryRow', () => {
  it('derives lengths, the oldest since, held locks and meter values', () => {
    const body = parsed(snapshot({
      queues: [queue(), queue({ name: 'review', items: [] })],
      locks: [lock(), lock({ name: 'deploy', heldBy: null, since: null })],
      meters: [meter(), meter({ name: 'budget', value: 1.5 })],
    }));
    expect(flowHistoryRow(body, NOW)).toEqual({
      at: NOW,
      queues: { landing: 2, review: 0 },
      oldest: { landing: NOW - 67 * 60 * MIN, review: null },
      locks: { landing: true, deploy: false },
      meters: { 'gate-slots': 4, budget: 1.5 },
    });
  });

  it('keeps a name such as __proto__ as an own key', () => {
    const row = flowHistoryRow(parsed(snapshot({ queues: [queue({ name: '__proto__' })] })), NOW);
    expect(Object.keys(row.queues)).toEqual(['__proto__']);
    expect(JSON.parse(JSON.stringify(row)).queues).toEqual(JSON.parse('{"__proto__":2}'));
  });
});

const record = (history: IFlowHistoryRow[] = [], overrides: Partial<IFlowRecord> = {}): IFlowRecord => ({
  workspaceId: 'ws-a', receivedAt: NOW, snapshot: parsed(), history, ...overrides,
});
const row = (at: number): IFlowHistoryRow => ({ at, queues: { landing: 2 }, oldest: { landing: at - MIN }, locks: { landing: true }, meters: { m: 1 } });

describe('appendFlowHistory', () => {
  it('measures the record exactly as it serializes', () => {
    const full = record([row(1), row(2), row(3)]);
    expect(flowRecordBytes(full)).toBe(new TextEncoder().encode(JSON.stringify(full)).length);
    expect(flowRecordBytes(record())).toBe(new TextEncoder().encode(JSON.stringify(record())).length);
  });

  it('keeps the newest 2000 rows, oldest dropped first', () => {
    const history = many(MAX_FLOW_HISTORY, (index) => row(index));
    const next = appendFlowHistory(record(history), row(MAX_FLOW_HISTORY));
    expect(next.history).toHaveLength(MAX_FLOW_HISTORY);
    expect(next.history[0].at).toBe(1);
    expect(next.history.at(-1)?.at).toBe(MAX_FLOW_HISTORY);
  });

  it('drops the oldest rows until the record fits in 4 MiB', () => {
    const names = many(50, (index) => `meter-${'m'.repeat(50)}-${index}`);
    const wide = (at: number): IFlowHistoryRow => ({
      at, queues: {}, oldest: {}, locks: {}, meters: Object.fromEntries(names.map((name) => [name, at])),
    });
    const next = appendFlowHistory(record(many(MAX_FLOW_HISTORY - 1, (index) => wide(index))), wide(1_000_000));
    expect(next.history.length).toBeLessThan(MAX_FLOW_HISTORY);
    expect(next.history.at(-1)?.at).toBe(1_000_000);
    expect(flowRecordBytes(next)).toBeLessThanOrEqual(MAX_FLOW_RECORD_BYTES);
    const oneMore = { ...next, history: [wide(next.history[0].at - 1), ...next.history] };
    expect(flowRecordBytes(oneMore)).toBeGreaterThan(MAX_FLOW_RECORD_BYTES);
  });
});

describe('parseFlowRecord', () => {
  it('re-validates a stored record', () => {
    const stored = record([row(NOW - MIN)]);
    expect(parseFlowRecord(JSON.parse(JSON.stringify(stored)), 'ws-a')).toEqual({ ok: true, record: stored });
  });

  it('does not refuse a stored snapshot for being in the future of the reader clock', () => {
    const stored = record([], { snapshot: parsed(snapshot({ generatedAt: NOW + MIN })) });
    expect(parseFlowRecord(stored, 'ws-a').ok).toBe(true);
  });

  it('names what does not re-validate', () => {
    const fail = (raw: unknown) => {
      const result = parseFlowRecord(raw, 'ws-a');
      if (result.ok) throw new Error('expected a refusal');
      return result.error;
    };
    expect(fail(null)).toBe('record: saw null, expected a flow record object');
    expect(fail(record([], { workspaceId: 'ws-b' }))).toBe('workspaceId: saw "ws-b", expected "ws-a"');
    expect(fail({ ...record(), receivedAt: 'x' })).toMatch(/^receivedAt: saw "x"/);
    expect(fail({ ...record(), snapshot: { ...snapshot(), source: '' } })).toMatch(/^snapshot\.source: /);
    expect(fail({ ...record(), history: {} })).toBe('history: saw {}, expected an array');
    expect(fail(record(many(MAX_FLOW_HISTORY + 1, (index) => row(index))))).toBe('history: saw 2001 entries, expected at most 2000');
    expect(fail({ ...record(), history: [{ ...row(NOW), at: -1 }] })).toMatch(/^history\[0\]\.at: saw -1/);
    const hostile = fail({ ...record(), history: [{ ...row(NOW), queues: { 'q\u202E\u001b': 'x' } }] });
    expect(hostile).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(hostile).toMatch(/^history\[0\]\.queues\.q\\u\{202E\}\\u\{1B\}: /);
    expect(fail({ ...record(), history: [{ ...row(NOW), queues: { landing: -1 } }] })).toMatch(/^history\[0\]\.queues\.landing: saw -1/);
    expect(fail({ ...record(), history: [{ ...row(NOW), oldest: { landing: 'x' } }] })).toMatch(/^history\[0\]\.oldest\.landing: saw "x"/);
    expect(fail({ ...record(), history: [{ ...row(NOW), locks: { landing: 1 } }] })).toMatch(/^history\[0\]\.locks\.landing: saw 1/);
    expect(fail({ ...record(), history: [{ ...row(NOW), meters: { m: null } }] })).toMatch(/^history\[0\]\.meters\.m: saw null/);
    expect(fail({ ...record(), history: [{ ...row(NOW), extra: 1 }] })).toMatch(/^history\[0\]\.extra: saw an unknown key/);
    expect(fail({ ...record(), more: 1 })).toMatch(/^more: saw an unknown key/);
  });
});

describe('history modes and staleness', () => {
  it('parses the history mode, with a default and a refusal', () => {
    expect(parseFlowHistoryMode(undefined, 'all')).toBe('all');
    expect(parseFlowHistoryMode(undefined, 'window')).toBe('window');
    expect(parseFlowHistoryMode('none', 'all')).toBe('none');
    expect(parseFlowHistoryMode('window', 'all')).toBe('window');
    expect(parseFlowHistoryMode('some', 'all')).toBeNull();
    expect(parseFlowHistoryMode(['all', 'none'], 'all')).toBeNull();
  });

  it('selects all rows, the window rows or none', () => {
    const stored = record([row(NOW - 400 * MIN), row(NOW - 360 * MIN), row(NOW - MIN)]);
    expect(selectFlowHistory(stored, 'all', NOW, 360).history).toHaveLength(3);
    expect(selectFlowHistory(stored, 'window', NOW, 360).history.map((entry) => entry.at)).toEqual([NOW - 360 * MIN, NOW - MIN]);
    expect(selectFlowHistory(stored, 'none', NOW, 360).history).toEqual([]);
    expect(stored.history).toHaveLength(3);
  });

  it('is stale more than 10 minutes after the receive time', () => {
    expect(FLOW_STALE_MS).toBe(600_000);
    expect(isFlowStale(NOW, NOW + FLOW_STALE_MS)).toBe(false);
    expect(isFlowStale(NOW, NOW + FLOW_STALE_MS + 1)).toBe(true);
  });

  it('states the snapshot ceiling as 1 MiB', () => {
    expect(MAX_FLOW_BYTES).toBe(1024 * 1024);
    expect(MAX_FLOW_RECORD_BYTES).toBe(4 * 1024 * 1024);
  });
});
