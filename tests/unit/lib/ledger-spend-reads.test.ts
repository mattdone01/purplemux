import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS } from '@/lib/ledger';
import { LedgerStore } from '@/lib/ledger-store';
import type { ILedgerEventInput, TLedgerItemType, TLedgerKind } from '@/types/ledger';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
const WS = 'ws-a';

let dir: string;
let store: LedgerStore;

const ev = (id: string, at: number, key: string, kind: TLedgerKind, extra: Partial<ILedgerEventInput> = {}): ILedgerEventInput => ({
  event_id: id, at, item_type: key.slice(0, key.indexOf(':')) as TLedgerItemType, item_key: key, kind,
  state: null, wait_reason: null, holder: null, clear_input: null, parent_key: null, attrs: null, ...extra,
});

const append = (events: ILedgerEventInput[], ws = WS) => store.append(ws, 'v2', events, events.at(-1)!.at);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-ledger-spend-'));
  store = new LedgerStore(path.join(dir, 'ledger.sqlite'));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('landedRanges (harness-flow-loop 04 AC 4, 04-F5)', () => {
  it('counts close events with state landed on ranges inside [since, until), one workspace only', () => {
    append([
      ev('o1', T0, 'range:a:1', 'open'), ev('c1', T0 + MIN, 'range:a:1', 'close', { state: 'landed' }),
      ev('o2', T0, 'range:a:2', 'open'), ev('c2', T0 + DAY_MS, 'range:a:2', 'close', { state: 'landed' }),
      ev('o3', T0, 'range:a:3', 'open'), ev('c3', T0 + 2 * MIN, 'range:a:3', 'close', { state: 'dropped' }),
      ev('o4', T0, 'range:a:4', 'open'),
      ev('o5', T0, 'landing:5', 'open'), ev('c5', T0 + MIN, 'landing:5', 'close', { state: 'landed' }),
    ]);
    append([ev('o9', T0, 'range:b:9', 'open'), ev('c9', T0 + MIN, 'range:b:9', 'close', { state: 'landed' })], 'ws-b');
    expect(store.landedRanges(WS, T0, T0 + DAY_MS)).toBe(1);
    expect(store.landedRanges(WS, T0, T0 + DAY_MS + 1)).toBe(2);
    expect(store.landedRanges(WS, T0 + 2 * MIN, T0 + DAY_MS)).toBe(0);
    expect(store.landedRanges('ws-none', T0, T0 + 2 * DAY_MS)).toBe(0);
  });

  it('counts each landing of a reopened range, and no landing for a stateless close after a landed state', () => {
    append([
      ev('o1', T0, 'range:a:1', 'open'), ev('c1', T0 + MIN, 'range:a:1', 'close', { state: 'landed' }),
      ev('r1', T0 + 2 * MIN, 'range:a:1', 'open'), ev('c1b', T0 + 3 * MIN, 'range:a:1', 'close', { state: 'landed' }),
      ev('o2', T0, 'range:a:2', 'open'), ev('s2', T0 + MIN, 'range:a:2', 'state', { state: 'landed' }),
      ev('c2', T0 + 2 * MIN, 'range:a:2', 'close'),
    ]);
    expect(store.landedRanges(WS, T0, T0 + DAY_MS)).toBe(2);
    expect(store.items(WS, {}, T0 + DAY_MS).items.find((item) => item.itemKey === 'range:a:2')?.state).toBe('landed');
  });

  it('reads the first item\'s open time, null for a workspace with none', () => {
    append([ev('o1', T0 + MIN, 'range:a:1', 'open'), ev('o2', T0, 'slice:a', 'open')]);
    expect(store.firstOpenedAt(WS)).toBe(T0);
    expect(store.firstOpenedAt('ws-none')).toBeNull();
  });
});

describe('phaseReplay (harness-flow-loop 04 AC 1)', () => {
  it('seeds the items silent since before the scan and returns the scan events in arrival order', () => {
    append([ev('old', T0, 'slice:a', 'open', { holder: 'tab-1' })]);
    append([ev('closed-old', T0, 'gate:x:1', 'open', { holder: 'tab-1' }), ev('closed-old-c', T0 + MIN, 'gate:x:1', 'close')]);
    const since = T0 + 10 * DAY_MS;
    append([ev('late', since - DAY_MS, 'range:a:1', 'open', { holder: 'tab-2' }), ev('in', since + MIN, 'range:a:1', 'wait', { wait_reason: 'review-queue' })]);
    append([ev('other-ws', since, 'range:b:1', 'open')], 'ws-b');
    const replay = store.phaseReplay(WS, since, since + DAY_MS);
    expect(replay.scanStart).toBe(since - 7 * DAY_MS);
    expect(replay.seed.map((row) => row.item_key)).toEqual(['slice:a']);
    expect(replay.events.map((event) => [event.item_key, event.kind])).toEqual([['range:a:1', 'open'], ['range:a:1', 'wait']]);
    expect(replay.events[1]).toMatchObject({ wait_reason: 'review-queue', holder: null, at: since + MIN });
    expect(replay.firstOpenedAt).toBe(T0);
    expect(replay.carried).toEqual([]);
  });

  it('carries the items open at the scan start whose first scanned event is not their open, and not the ones closed before it', () => {
    const since = T0 + 10 * DAY_MS;
    append([ev('o1', T0, 'range:a:1', 'open', { holder: 'tab-1' }), ev('o2', T0, 'range:a:2', 'open'),
      ev('c2', T0 + MIN, 'range:a:2', 'close', { state: 'landed' })]);
    append([ev('w1', since, 'range:a:1', 'wait', { wait_reason: 'not-armed' }), ev('late2', since, 'range:a:2', 'state', { state: 'x' })]);
    const replay = store.phaseReplay(WS, since, since + DAY_MS);
    expect(replay.seed).toEqual([]);
    expect(replay.carried.map((row) => [row.item_key, row.holder, row.wait_reason])).toEqual([['range:a:1', 'tab-1', 'not-armed']]);
  });

  it('answers no history for a workspace the ledger never heard from', () => {
    expect(store.phaseReplay('ws-none', T0, T0 + DAY_MS)).toEqual({ workspaceId: 'ws-none', scanStart: T0 - 7 * DAY_MS, seed: [], events: [], carried: [], firstOpenedAt: null });
  });
});
