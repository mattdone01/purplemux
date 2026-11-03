import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FINDER_LOOKBACK_MS, FINDER_WAKES_WINDOW_MS, deriveConstraint } from '@/lib/constraint';
import { LedgerStore } from '@/lib/ledger-store';
import type { ILedgerEventInput, TLedgerItemType, TLedgerKind } from '@/types/ledger';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 3, 6, 0, 0);
const WS = 'ws-a';

let dir: string;
let store: LedgerStore;

const ev = (id: string, at: number, key: string, kind: TLedgerKind, extra: Partial<ILedgerEventInput> = {}): ILedgerEventInput => ({
  event_id: id, at, item_type: key.slice(0, key.indexOf(':')) as TLedgerItemType, item_key: key, kind,
  state: null, wait_reason: null, holder: null, clear_input: null, parent_key: null, attrs: null, ...extra,
});

const append = (producer: string, events: ILedgerEventInput[], ws = WS) => store.append(ws, producer, events, events.at(-1)!.at);

const snapshot = (ws = WS) => store.finderSnapshot(ws, { since: NOW - FINDER_LOOKBACK_MS, wakesSince: NOW - FINDER_WAKES_WINDOW_MS }, NOW);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-ledger-finder-'));
  store = new LedgerStore(path.join(dir, 'ledger.sqlite'));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('LedgerStore.finderSnapshot', () => {
  it('reads 14 days of waits, open and recently closed items, and the producer of each open item', () => {
    append('backfill', [
      ev('o0', NOW - 20 * DAY, 'range:a:old', 'open'),
      ev('w0', NOW - 20 * DAY, 'range:a:old', 'wait', { wait_reason: 'not-armed' }),
      ev('c0', NOW - 19 * DAY, 'range:a:old', 'close', { state: 'landed' }),
    ]);
    append('landchain', [
      ev('o1', NOW - 3 * HOUR, 'range:a:1', 'open'),
      ev('w1', NOW - 3 * HOUR, 'range:a:1', 'wait', { wait_reason: 'not-armed', holder: 'lane-a' }),
      ev('c1', NOW - HOUR, 'range:a:1', 'close', { state: 'landed' }),
      ev('o2', NOW - 150 * MIN, 'range:a:2', 'open'),
      ev('w2', NOW - 150 * MIN, 'range:a:2', 'wait', { wait_reason: 'review-findings', holder: 'lane-a', clear_input: 'fix F1' }),
    ]);
    append('gate', [ev('g1', NOW - 20 * MIN, 'gate:t1:1', 'open', { attrs: { mode: 'affected' } })]);
    append('landchain', [ev('o9', NOW - HOUR, 'range:b:1', 'open')], 'ws-b');

    const snap = snapshot();
    expect(snap.intervals).toEqual([
      { itemKey: 'range:a:1', itemType: 'range', reason: 'not-armed', holder: 'lane-a', start: NOW - 3 * HOUR, end: NOW - HOUR },
    ]);
    expect(snap.items.map((item) => item.itemKey).sort()).toEqual(['gate:t1:1', 'range:a:1', 'range:a:2']);
    expect(snap.lastProducer).toEqual({ 'gate:t1:1': 'gate', 'range:a:2': 'landchain' });
    expect(snap.firstEventAt).toBe(NOW - 20 * DAY);
    expect(snap.tabWakes).toBeNull();

    const result = deriveConstraint(snap, null, null, null, NOW);
    expect(result.constraint).toMatchObject({ reason: 'review-findings', ownerSeat: 'lane-a', clearInput: 'fix F1', waitingHours: 2.5 });
    expect(result.stuck.map((s) => s.key)).toEqual(['range:a:2']);
  });

  it('counts deliveries per tab in 6 h, one per digest, never log rows or undelivered ones', () => {
    const row = (tabId: string, at: number, extra: { class?: string; deliveredAt?: number | null; digestId?: string | null } = {}) =>
      store.insertTabEvent({ workspaceId: WS, tabId, at, class: extra.class ?? 'urgent', kind: 'nudge', text: 'x',
        deliveredAt: extra.deliveredAt === undefined ? at : extra.deliveredAt, digestId: extra.digestId ?? null });
    row('tab-o', NOW - HOUR);
    row('tab-o', NOW - 2 * HOUR);
    row('tab-o', NOW - 3 * HOUR, { class: 'digest', deliveredAt: NOW - 30 * MIN, digestId: 'd1' });
    row('tab-o', NOW - 2 * HOUR, { class: 'digest', deliveredAt: NOW - 30 * MIN, digestId: 'd1' });
    row('tab-o', NOW - HOUR, { class: 'log' });
    row('tab-o', NOW - HOUR, { class: 'digest', deliveredAt: null });
    row('tab-o', NOW - 7 * HOUR);
    row('tab-k', NOW - 8 * HOUR, { class: 'digest', deliveredAt: NOW - 5 * HOUR, digestId: 'd2' });
    expect(snapshot().tabWakes).toEqual([{ tabId: 'tab-k', wakes: 1 }, { tabId: 'tab-o', wakes: 3 }]);
    expect(snapshot('ws-b').tabWakes).toBeNull();
  });
});
