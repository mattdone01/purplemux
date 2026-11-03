import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS } from '@/lib/ledger';
import { LedgerStore } from '@/lib/ledger-store';
import type { ITabEventInput } from '@/types/tab-events';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 3, 0, 0, 0);
const WS = 'ws-a';

let dir: string;
let file: string;
let store: LedgerStore;

const ev = (extra: Partial<ITabEventInput> = {}): ITabEventInput => ({
  workspaceId: WS, tabId: 'tab-o', at: T0, class: 'digest', kind: 'turn-marker', text: 'x', ...extra,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-tab-events-'));
  file = path.join(dir, 'ledger.sqlite');
  store = new LedgerStore(file);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('tab_events shape (ADR-0035 §3)', () => {
  it('adds its columns to a file story 01 wrote, keeps user_version 1 and the rows', () => {
    store.tabEvents.append(ev({ text: 'before' }));
    store.close();
    const raw = new Database(file);
    raw.exec(`DROP INDEX tab_events_pending_idx; DROP INDEX tab_events_delivered_idx; DROP INDEX tab_events_digest_idx;
      DROP INDEX tab_events_sourced_idx;`);
    raw.exec('ALTER TABLE tab_events DROP COLUMN source_tab_name; ALTER TABLE tab_events DROP COLUMN source_tab_id;');
    raw.close();
    store = new LedgerStore(file);
    expect(store.pragma('user_version')).toBe(1);
    expect(store.columns('tab_events').slice(-2)).toEqual(['source_tab_id', 'source_tab_name']);
    expect(store.tabEvents.list(WS, { since: 0, limit: 10 }).map((row) => row.text)).toEqual(['before']);
  });
});

describe('the write and read path', () => {
  it('appends, lists newest last within the limit, and filters by tab and by source', () => {
    store.tabEvents.append(ev({ at: T0, text: 'a', sourceTabId: 'tab-w', sourceTabName: 'w' }));
    store.tabEvents.append(ev({ at: T0 + MIN, text: 'b', tabId: 'tab-p' }));
    store.tabEvents.append(ev({ at: T0 + 2 * MIN, text: 'c' }));
    expect(store.tabEvents.list(WS, { since: 0, limit: 10 }).map((row) => row.text)).toEqual(['a', 'b', 'c']);
    expect(store.tabEvents.list(WS, { since: 0, limit: 2 }).map((row) => row.text)).toEqual(['b', 'c']);
    expect(store.tabEvents.list(WS, { tabId: 'tab-o', since: 0, limit: 10 }).map((row) => row.text)).toEqual(['a', 'c']);
    expect(store.tabEvents.list(WS, { since: T0 + MIN, limit: 10 }).map((row) => row.text)).toEqual(['b', 'c']);
    const [sourced] = store.tabEvents.list(WS, { since: 0, limit: 10, sourced: true });
    expect(sourced).toMatchObject({ text: 'a', sourceTabId: 'tab-w', sourceTabName: 'w', deliveredAt: null, digestId: null });
    expect(store.tabEvents.list('ws-b', { since: 0, limit: 10 })).toEqual([]);
  });

  it('finds the same tab, kind and text at or after a time, and nothing else', () => {
    store.tabEvents.append(ev({ at: T0, text: 'same' }));
    expect(store.tabEvents.hasSame(WS, 'tab-o', 'turn-marker', 'same', T0)).toBe(true);
    expect(store.tabEvents.hasSame(WS, 'tab-o', 'turn-marker', 'same', T0 + 1)).toBe(false);
    expect(store.tabEvents.hasSame(WS, 'tab-o', 'stuck', 'same', 0)).toBe(false);
    expect(store.tabEvents.hasSame(WS, 'tab-p', 'turn-marker', 'same', 0)).toBe(false);
    expect(store.tabEvents.hasSame(WS, 'tab-o', 'turn-marker', 'other', 0)).toBe(false);
    store.tabEvents.append(ev({ at: T0, text: 'logged', class: 'log' }));
    expect(store.tabEvents.hasSame(WS, 'tab-o', 'turn-marker', 'logged', 0)).toBe(false);
  });

  it('keeps digest events pending until marked, per tab, oldest first', () => {
    const a = store.tabEvents.append(ev({ at: T0, text: 'a' }));
    const b = store.tabEvents.append(ev({ at: T0 + MIN, text: 'b' }));
    store.tabEvents.append(ev({ at: T0 + MIN, text: 'u', class: 'urgent' }));
    store.tabEvents.append(ev({ at: T0 + MIN, text: 'l', class: 'log' }));
    store.tabEvents.append(ev({ at: T0 + 2 * MIN, text: 'p', tabId: 'tab-p' }));
    expect(store.tabEvents.pending(WS, 'tab-o').map((row) => row.text)).toEqual(['a', 'b']);
    expect(store.tabEvents.pendingTabs()).toEqual([
      { workspaceId: WS, tabId: 'tab-o', count: 2, oldestAt: T0 },
      { workspaceId: WS, tabId: 'tab-p', count: 1, oldestAt: T0 + 2 * MIN },
    ]);
    expect(store.tabEvents.lastDigestAt(WS, 'tab-o')).toBeNull();
    store.tabEvents.markDelivered([a, b], T0 + 5 * MIN, 'dg-1');
    expect(store.tabEvents.pending(WS, 'tab-o')).toEqual([]);
    expect(store.tabEvents.lastDigestAt(WS, 'tab-o')).toBe(T0 + 5 * MIN);
    expect(store.tabEvents.pendingTabs().map((row) => row.tabId)).toEqual(['tab-p']);
  });

  it('marks more rows than one statement may bind', () => {
    const seqs = Array.from({ length: 1_200 }, (_, i) => store.tabEvents.append(ev({ at: T0 + i, text: `e${i}` })));
    store.tabEvents.markDelivered(seqs, T0 + DAY_MS, 'dg-big');
    expect(store.tabEvents.pending(WS, 'tab-o')).toEqual([]);
  });

  it('knows whether a workspace has any tab event', () => {
    expect(store.tabEvents.hasAny(WS)).toBe(false);
    store.tabEvents.append(ev());
    expect(store.tabEvents.hasAny(WS)).toBe(true);
    expect(store.tabEvents.hasAny('ws-b')).toBe(false);
  });
});

describe('wakes per seat (AC 6)', () => {
  const seed = () => {
    // tab-o: two urgent deliveries and one digest of three events on day 1, one urgent on day 2, one logged,
    // one urgent never delivered (its tab was gone). tab-p: one digest.
    const deliver = (at: number, extra: Partial<ITabEventInput>) => store.tabEvents.append(ev({ at, deliveredAt: at, class: 'urgent', ...extra }));
    deliver(T0 + MIN, {});
    deliver(T0 + 2 * MIN, {});
    const digest = [0, 1, 2].map((i) => store.tabEvents.append(ev({ at: T0 + i * MIN })));
    store.tabEvents.markDelivered(digest, T0 + 20 * MIN, 'dg-o1');
    deliver(T0 + DAY_MS + MIN, {});
    store.tabEvents.append(ev({ at: T0 + 3 * MIN, class: 'log' }));
    store.tabEvents.append(ev({ at: T0 + 4 * MIN, class: 'urgent' }));
    const p = store.tabEvents.append(ev({ at: T0, tabId: 'tab-p' }));
    store.tabEvents.markDelivered([p], T0 + 30 * MIN, 'dg-p1');
  };

  it('counts a delivery once: an urgent event, or a digest however many events it carried', () => {
    seed();
    expect(store.tabEvents.wakes(WS, { since: T0, until: T0 + 2 * DAY_MS })).toEqual([
      { tabId: 'tab-o', day: null, wakes: 4, digests: 1, urgent: 3, logged: 1 },
      { tabId: 'tab-p', day: null, wakes: 1, digests: 1, urgent: 0, logged: 0 },
    ]);
  });

  it('splits by the UTC day of the delivery and clips to the window', () => {
    seed();
    expect(store.tabEvents.wakes(WS, { since: T0, until: T0 + 2 * DAY_MS, byDay: true })).toEqual([
      { tabId: 'tab-o', day: '2026-11-03', wakes: 3, digests: 1, urgent: 2, logged: 1 },
      { tabId: 'tab-o', day: '2026-11-04', wakes: 1, digests: 0, urgent: 1, logged: 0 },
      { tabId: 'tab-p', day: '2026-11-03', wakes: 1, digests: 1, urgent: 0, logged: 0 },
    ]);
    expect(store.tabEvents.wakes(WS, { since: T0 + 15 * MIN, until: T0 + 25 * MIN })).toEqual([
      { tabId: 'tab-o', day: null, wakes: 1, digests: 1, urgent: 0, logged: 0 },
    ]);
    expect(store.tabEvents.wakes('ws-b', { since: T0, until: T0 + 2 * DAY_MS })).toEqual([]);
  });
});
