import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IInboxState } from '@/types/inbox';

const mockHome = vi.hoisted(() => ({ value: '' }));
// The file logger writes under the temp HOME, which each test removes; a write
// still pending at removal surfaced as an unhandled ENOENT (gate 26-r1).
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

const T0 = Date.parse('2026-09-26T06:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

const load = () => import('@/lib/inbox-store');

const req = (overrides: Record<string, unknown> = {}) => ({
  kind: 'resume' as const,
  targetWorkspaceId: 'ws-1',
  targetTabId: 'tab-w',
  dedupeKey: 'resume:tab-w:1',
  fields: { resumeId: 'r-abcd12' },
  ...overrides,
});

let seq = 0;
const ids = () => `i-${String(++seq).padStart(4, '0')}`;

describe('inbox store — pure transitions', () => {
  beforeEach(() => { seq = 0; });

  it('queues one item with the rendered line, and returns it again for a queued dedupeKey', async () => {
    const { enqueueInState } = await load();
    const first = enqueueInState({ items: [] }, req(), T0, ids);
    expect(first.created).toBe(true);
    expect(first.item).toMatchObject({
      id: 'i-0001', state: 'queued', attempts: 0, notBefore: T0, expiresAt: T0 + 24 * HOUR,
      line: '[purplemux resume r-abcd12] the last turn ended on an API error — continue from where it was cut off',
    });
    const second = enqueueInState(first.state, req(), T0 + 1, ids);
    expect(second.created).toBe(false);
    expect(second.item.id).toBe('i-0001');
    expect(second.state.items).toHaveLength(1);
  });

  it('keeps one queued item per target and key: a broadcast reaches every recipient', async () => {
    const { enqueueInState } = await load();
    let state: IInboxState = { items: [] };
    for (const tab of ['tab-a', 'tab-b', 'tab-c']) {
      const r = enqueueInState(state, req({ targetTabId: tab, dedupeKey: 'deploy-d-1' }), T0, ids);
      expect(r.created).toBe(true);
      expect(r.item.targetTabId).toBe(tab);
      state = r.state;
    }
    expect(enqueueInState(state, req({ targetTabId: 'tab-b', dedupeKey: 'deploy-d-1' }), T0, ids).created).toBe(false);
    expect(state.items).toHaveLength(3);
  });

  it('returns the same state object from a sweep that changed nothing (a quiet tick writes nothing)', async () => {
    const { enqueueInState, sweepInState } = await load();
    const { state } = enqueueInState({ items: [] }, req(), T0, ids);
    expect(sweepInState(state, T0 + 1)).toBe(state);
    const empty = { items: [] };
    expect(sweepInState(empty, T0)).toBe(empty);
  });

  it('drops only the queued and held items of targets the boot pass confirms gone', async () => {
    const { enqueueInState, holdInState, deliverInState, dropGoneTargetsInState } = await load();
    let state: IInboxState = { items: [] };
    const q = enqueueInState(state, req({ dedupeKey: 'q', targetTabId: 'tab-gone' }), T0, ids); state = q.state;
    const h = enqueueInState(state, req({ dedupeKey: 'h', targetTabId: 'tab-gone' }), T0, ids); state = holdInState(h.state, h.item.id, 'x', T0);
    const d = enqueueInState(state, req({ dedupeKey: 'd', targetTabId: 'tab-gone' }), T0, ids); state = deliverInState(d.state, d.item.id, T0);
    const live = enqueueInState(state, req({ dedupeKey: 'l', targetTabId: 'tab-live' }), T0, ids); state = live.state;
    const result = dropGoneTargetsInState(state, (_ws, tab) => tab === 'tab-gone', T0 + 1);
    expect(result.dropped.map((i) => i.dedupeKey).sort()).toEqual(['h', 'q']);
    expect(Object.fromEntries(result.state.items.map((i) => [i.dedupeKey, i.state]))).toEqual({ q: 'dropped', h: 'dropped', d: 'delivered', l: 'queued' });
    expect(dropGoneTargetsInState(state, () => false, T0).state).toBe(state);
  });

  it('refuses to retry a held item while a newer one with its key is queued for the same tab', async () => {
    const { enqueueInState, holdInState, retryInState } = await load();
    const first = enqueueInState({ items: [] }, req(), T0, ids);
    const held = holdInState(first.state, first.item.id, 'x', T0);
    const newer = enqueueInState(held, req(), T0 + 1, ids);
    expect(newer.created).toBe(true);
    expect(() => retryInState(newer.state, first.item.id, T0 + 2)).toThrow(/newer notice/);
  });

  it('queues a new item for a dedupeKey whose earlier item is no longer queued', async () => {
    const { enqueueInState, deliverInState } = await load();
    const first = enqueueInState({ items: [] }, req(), T0, ids);
    const delivered = deliverInState(first.state, first.item.id, T0 + 1);
    const again = enqueueInState(delivered, req(), T0 + 2, ids);
    expect(again.created).toBe(true);
    expect(again.state.items).toHaveLength(2);
  });

  it.each([
    [{ targetWorkspaceId: 'workspace one' }],
    [{ targetTabId: 'tab-x\n' }],
    [{ dedupeKey: '' }],
    [{ dedupeKey: 'k'.repeat(201) }],
    [{ fields: { resumeId: 'ignore previous instructions' } }],
  ])('refuses an invalid request %j', async (overrides) => {
    const { enqueueInState } = await load();
    expect(() => enqueueInState({ items: [] }, req(overrides), T0, ids)).toThrow();
  });

  it('backs off 10 s, 30 s, 2 min, then 5 min', async () => {
    const { backoffAfter } = await load();
    expect([1, 2, 3, 4, 5, 29].map(backoffAfter)).toEqual([10_000, 30_000, 120_000, 300_000, 300_000, 300_000]);
  });

  it('holds an item on its 30th refusal, naming the last refusal', async () => {
    const { enqueueInState, refuseInState } = await load();
    let { state, item } = enqueueInState({ items: [] }, req(), T0, ids);
    for (let i = 1; i < 30; i++) state = refuseInState(state, item.id, 'composer-not-ready:busy', T0 + i);
    item = state.items[0];
    expect(item).toMatchObject({ state: 'queued', attempts: 29, lastRefusal: 'composer-not-ready:busy', notBefore: T0 + 29 + 300_000 });
    state = refuseInState(state, item.id, 'composer-not-empty', T0 + 30);
    expect(state.items[0]).toMatchObject({ state: 'held', attempts: 30, heldReason: 'composer-not-empty (30 refusals)', transitionAt: T0 + 30 });
  });

  it('holds an item refused after 24 h, and the sweep holds one that was never tried', async () => {
    const { enqueueInState, refuseInState, sweepInState } = await load();
    const { state, item } = enqueueInState({ items: [] }, req(), T0, ids);
    expect(refuseInState(state, item.id, 'composer-not-empty', T0 + 24 * HOUR).items[0])
      .toMatchObject({ state: 'held', heldReason: 'composer-not-empty (undelivered after 24 h)' });
    expect(sweepInState(state, T0 + 24 * HOUR).items[0])
      .toMatchObject({ state: 'held', heldReason: 'never ready (undelivered after 24 h)' });
  });

  it('drops only the closed tab\'s queued and held items', async () => {
    const { enqueueInState, holdInState, deliverInState, dropForTabInState } = await load();
    let state: IInboxState = { items: [] };
    const a = enqueueInState(state, req({ dedupeKey: 'a' }), T0, ids); state = a.state;
    const b = enqueueInState(state, req({ dedupeKey: 'b' }), T0, ids); state = b.state;
    const c = enqueueInState(state, req({ dedupeKey: 'c' }), T0, ids); state = c.state;
    const other = enqueueInState(state, req({ dedupeKey: 'd', targetTabId: 'tab-o' }), T0, ids); state = other.state;
    state = holdInState(state, b.item.id, 'transport-uncertain:x', T0 + 1);
    state = deliverInState(state, c.item.id, T0 + 1);
    const result = dropForTabInState(state, 'ws-1', 'tab-w', 'target-tab-closed', T0 + 2);
    expect(result.dropped.map((i) => i.id).sort()).toEqual([a.item.id, b.item.id].sort());
    expect(Object.fromEntries(result.state.items.map((i) => [i.dedupeKey, i.state])))
      .toEqual({ a: 'dropped', b: 'dropped', c: 'delivered', d: 'queued' });
    expect(result.state.items.find((i) => i.dedupeKey === 'a')).toMatchObject({ droppedReason: 'target-tab-closed', transitionAt: T0 + 2 });
  });

  it('withdraws one waiting item (queued or held) by id, never a delivered one', async () => {
    const { enqueueInState, holdInState, deliverInState, withdrawInState } = await load();
    let state: IInboxState = { items: [] };
    const q = enqueueInState(state, req({ dedupeKey: 'q' }), T0, ids); state = q.state;
    const h = enqueueInState(state, req({ dedupeKey: 'h' }), T0, ids); state = holdInState(h.state, h.item.id, 'x', T0 + 1);
    const d = enqueueInState(state, req({ dedupeKey: 'd' }), T0, ids); state = deliverInState(d.state, d.item.id, T0 + 1);
    for (const id of [q.item.id, h.item.id, d.item.id]) state = withdrawInState(state, id, 'note-rerouted', T0 + 2);
    expect(Object.fromEntries(state.items.map((i) => [i.dedupeKey, i.state]))).toEqual({ q: 'dropped', h: 'dropped', d: 'delivered' });
    expect(state.items.find((i) => i.dedupeKey === 'q')).toMatchObject({ droppedReason: 'note-rerouted', transitionAt: T0 + 2 });
    expect(withdrawInState(state, 'i-nosuchitem', 'x', T0 + 3)).toEqual(state);
  });

  it('drops a queued or held item at its staleAt instead of typing it; an item without one never goes stale', async () => {
    const { enqueueInState, holdInState, deliverInState, sweepInState } = await load();
    let state: IInboxState = { items: [] };
    const q = enqueueInState(state, { ...req({ dedupeKey: 'q' }), staleAt: T0 + MIN }, T0, ids); state = q.state;
    const h = enqueueInState(state, { ...req({ dedupeKey: 'h' }), staleAt: T0 + MIN }, T0, ids); state = holdInState(h.state, h.item.id, 'x', T0 + 1);
    const d = enqueueInState(state, { ...req({ dedupeKey: 'd' }), staleAt: T0 + MIN }, T0, ids); state = deliverInState(d.state, d.item.id, T0 + 1);
    const n = enqueueInState(state, req({ dedupeKey: 'n' }), T0, ids); state = n.state;
    expect(sweepInState(state, T0 + MIN - 1)).toBe(state);
    const swept = sweepInState(state, T0 + MIN);
    expect(Object.fromEntries(swept.items.map((i) => [i.dedupeKey, [i.state, i.droppedReason]])))
      .toEqual({ q: ['dropped', 'stale'], h: ['dropped', 'stale'], d: ['delivered', null], n: ['queued', null] });
  });

  it('prunes delivered, dropped and held items 7 days after their last transition, never queued ones', async () => {
    const { enqueueInState, deliverInState, holdInState, sweepInState } = await load();
    let state: IInboxState = { items: [] };
    const d = enqueueInState(state, req({ dedupeKey: 'd' }), T0, ids); state = deliverInState(d.state, d.item.id, T0);
    const h = enqueueInState(state, req({ dedupeKey: 'h' }), T0, ids); state = holdInState(h.state, h.item.id, 'x', T0 + HOUR);
    const q = enqueueInState(state, req({ dedupeKey: 'q', targetTabId: 'tab-q' }), T0 + 7 * 24 * HOUR - MIN, ids); state = q.state;
    const week = 7 * 24 * HOUR;
    expect(sweepInState(state, T0 + week).items.map((i) => i.dedupeKey)).toEqual(['h', 'q']);
    expect(sweepInState(state, T0 + HOUR + week).items.map((i) => i.dedupeKey)).toEqual(['q']);
  });

  it('retries a held item once with a fresh budget, and refuses anything else', async () => {
    const { enqueueInState, holdInState, retryInState, InboxError } = await load();
    const { state, item } = enqueueInState({ items: [] }, req(), T0, ids);
    expect(() => retryInState(state, item.id, T0)).toThrow(InboxError);
    expect(() => retryInState(state, 'i-none', T0)).toThrow(/not found/);
    const held = holdInState(state, item.id, 'composer-not-empty (30 refusals)', T0 + 1);
    const retried = retryInState(held, item.id, T0 + 2).item;
    expect(retried).toMatchObject({ state: 'queued', attempts: 0, notBefore: T0 + 2, heldReason: null, expiresAt: T0 + 2 + 24 * HOUR });
  });

  it('picks the oldest queued item per tab, due by backoff or by an early wake', async () => {
    const { enqueueInState, refuseInState, dueItems } = await load();
    let state: IInboxState = { items: [] };
    const first = enqueueInState(state, req({ dedupeKey: '1' }), T0, ids); state = first.state;
    const second = enqueueInState(state, req({ dedupeKey: '2' }), T0 + 1, ids); state = second.state;
    const other = enqueueInState(state, req({ dedupeKey: '3', targetTabId: 'tab-o' }), T0 + 2, ids); state = other.state;
    expect(dueItems(state, T0 + 5, () => false).map((i) => i.dedupeKey)).toEqual(['1', '3']);

    state = refuseInState(state, first.item.id, 'composer-not-ready:busy', T0 + 5);
    // The refused item is not due, and the later one for the same tab never overtakes it.
    expect(dueItems(state, T0 + 6, () => false).map((i) => i.dedupeKey)).toEqual(['3']);
    expect(dueItems(state, T0 + 6, (i) => i.id === first.item.id).map((i) => i.dedupeKey)).toEqual(['1', '3']);
    expect(dueItems(state, T0 + 5 + 10_000, () => false).map((i) => i.dedupeKey)).toEqual(['1', '3']);
  });
});

describe('inbox store — held recovery (ws-5TO0NJ, 2026-10-08)', () => {
  beforeEach(() => { seq = 0; });

  const watchReq = (overrides: Record<string, unknown> = {}) =>
    req({ kind: 'watch', fields: { watchId: 'w-abcd1234', target: 'merge:o/r', notice: 'free' }, ...overrides });

  const heldByRefusals = async (reason = 'composer-not-empty', request = watchReq()) => {
    const { enqueueInState, refuseInState } = await load();
    let { state, item } = enqueueInState({ items: [] }, request, T0, ids);
    for (let i = 1; i <= 30; i++) state = refuseInState(state, item.id, reason, T0 + i * MIN);
    item = state.items[0];
    return { state, item };
  };

  it('reads a refusal-budget hold as recoverable until the item expires; a paste-uncertain hold never', async () => {
    const { isRecoverableHold, enqueueInState, holdInState, INBOX_MAX_AGE_MS } = await load();
    const { item } = await heldByRefusals();
    expect(item).toMatchObject({ state: 'held', heldReason: 'composer-not-empty (30 refusals)' });
    expect(isRecoverableHold(item, T0 + HOUR)).toBe(true);
    expect(isRecoverableHold(item, T0 + INBOX_MAX_AGE_MS)).toBe(false);
    const queued = enqueueInState({ items: [] }, watchReq(), T0, ids);
    for (const reason of ['transport-uncertain:tmux paste failed', 'stranded-in-composer', 'target-not-agent', 'composer-not-empty (undelivered after 24 h)']) {
      expect(isRecoverableHold(holdInState(queued.state, queued.item.id, reason, T0).items[0], T0 + 1)).toBe(false);
    }
    expect(isRecoverableHold(queued.item, T0)).toBe(false);
  });

  it('never recovers a held resume (its orchestrator was told and may resume by hand) or a held mission (its row closed)', async () => {
    const { isRecoverableHold } = await load();
    const resume = await heldByRefusals('composer-not-empty', req());
    expect(isRecoverableHold(resume.item, T0 + HOUR)).toBe(false);
    const mission = await heldByRefusals('composer-not-empty', req({
      kind: 'mission', fields: { event: 'bootstrap', bootstrapKey: `boot-${'a'.repeat(32)}`, workspaceId: 'ws-1' },
    }));
    expect(isRecoverableHold(mission.item, T0 + HOUR)).toBe(false);
  });

  it('keeps a recoverable hold at the head of its tab: probed every 5 min or on a wake, and nothing behind it overtakes', async () => {
    const { enqueueInState, dueItems, HELD_REPROBE_MS } = await load();
    const held = await heldByRefusals();
    let state = held.state;
    const lastAttempt = held.item.lastAttemptAt!;
    state = enqueueInState(state, watchReq({ dedupeKey: 'later' }), lastAttempt + 1, ids).state;
    state = enqueueInState(state, watchReq({ dedupeKey: 'other', targetTabId: 'tab-o' }), lastAttempt + 1, ids).state;
    expect(dueItems(state, lastAttempt + 2, () => false).map((i) => i.dedupeKey)).toEqual(['other']);
    expect(dueItems(state, lastAttempt + 2, (i) => i.id === held.item.id).map((i) => i.dedupeKey)).toEqual([held.item.dedupeKey, 'other']);
    expect(dueItems(state, lastAttempt + HELD_REPROBE_MS, () => false).map((i) => i.dedupeKey)).toEqual([held.item.dedupeKey, 'other']);
  });

  it('lets the queue pass a hold that is not recoverable', async () => {
    const { enqueueInState, holdInState, dueItems } = await load();
    const first = enqueueInState({ items: [] }, watchReq({ dedupeKey: 'stranded' }), T0, ids);
    let state = holdInState(first.state, first.item.id, 'stranded-in-composer', T0 + 1);
    state = enqueueInState(state, watchReq({ dedupeKey: 'next' }), T0 + 2, ids).state;
    expect(dueItems(state, T0 + 3, () => false).map((i) => i.dedupeKey)).toEqual(['next']);
  });

  it('records a re-probe of a recoverable hold: a refusal keeps it held, a delivery delivers it, a strand ends recovery', async () => {
    const { refuseInState, deliverInState, holdInState, isRecoverableHold } = await load();
    const { state, item } = await heldByRefusals();
    const at = T0 + 2 * HOUR;
    const refused = refuseInState(state, item.id, 'composer-not-ready:busy', at).items[0];
    expect(refused).toMatchObject({ state: 'held', attempts: 31, lastAttemptAt: at, lastRefusal: 'composer-not-ready:busy', heldReason: 'composer-not-ready:busy (31 refusals)', transitionAt: item.transitionAt });
    expect(deliverInState(state, item.id, at).items[0]).toMatchObject({ state: 'delivered', deliveredAt: at, transitionAt: at });
    const stranded = holdInState(state, item.id, 'stranded-in-composer', at).items[0];
    expect(stranded).toMatchObject({ state: 'held', heldReason: 'stranded-in-composer', lastAttemptAt: at });
    expect(isRecoverableHold(stranded, at)).toBe(false);
  });

  it('never delivers or re-holds a hold that is not recoverable', async () => {
    const { enqueueInState, holdInState, deliverInState, refuseInState } = await load();
    const queued = enqueueInState({ items: [] }, watchReq(), T0, ids);
    const state = holdInState(queued.state, queued.item.id, 'transport-uncertain:x', T0 + 1);
    expect(deliverInState(state, queued.item.id, T0 + 2)).toEqual(state);
    expect(refuseInState(state, queued.item.id, 'composer-not-empty', T0 + 2)).toEqual(state);
    expect(holdInState(state, queued.item.id, 'stranded-in-composer', T0 + 2)).toEqual(state);
  });
});

describe('inbox store — file', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-inbox-'));
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('reads an absent file as empty and writes the queued notice with mode 0600', async () => {
    const { enqueueNotice, readInboxState, inboxFile } = await load();
    expect(await readInboxState()).toEqual({ items: [] });
    const { item, created } = await enqueueNotice(req());
    expect(created).toBe(true);
    expect(item.id).toMatch(/^i-[A-Za-z0-9_-]{10}$/);
    expect((await readInboxState()).items).toEqual([item]);
    expect((await fs.stat(inboxFile())).mode & 0o777).toBe(0o600);
    expect((await enqueueNotice(req())).item.id).toBe(item.id);
  });

  it('refuses a file with a malformed item instead of silently discarding it', async () => {
    const { readInboxState, enqueueNotice, inboxFile } = await load();
    await enqueueNotice(req());
    const raw = JSON.parse(await fs.readFile(inboxFile(), 'utf-8'));
    raw.items.push({ id: 7 });
    await fs.writeFile(inboxFile(), JSON.stringify(raw));
    await expect(readInboxState()).rejects.toThrow(/item 1 is malformed/);
  });

  it('refuses a corrupt file instead of reading it as empty', async () => {
    const { readInboxState, enqueueNotice, inboxFile } = await load();
    await fs.mkdir(path.dirname(inboxFile()), { recursive: true });
    await fs.writeFile(inboxFile(), '{"leases": []}');
    await expect(readInboxState()).rejects.toThrow(/no "items" array/);
    await expect(enqueueNotice(req())).rejects.toThrow();
    await fs.writeFile(inboxFile(), 'not json');
    await expect(readInboxState()).rejects.toThrow();
  });

  it('serialises concurrent enqueues under the one lock', async () => {
    const { enqueueNotice, readInboxState } = await load();
    await Promise.all(Array.from({ length: 12 }, (_, i) => enqueueNotice(req({ dedupeKey: `k${i}` }))));
    expect((await readInboxState()).items).toHaveLength(12);
  });

  it('tells onInboxHeld once per item that becomes held, after the write', async () => {
    const { enqueueNotice, mutateInbox, holdInState, refuseInState, onInboxHeld, readInboxState } = await load();
    const seen: string[] = [];
    const off = onInboxHeld((item) => seen.push(`${item.id}:${item.heldReason}`));
    try {
      const { item } = await enqueueNotice(req());
      await mutateInbox((s) => ({ state: refuseInState(s, item.id, 'composer-not-empty', Date.now()), value: null }));
      expect(seen).toEqual([]);
      await mutateInbox((s) => ({ state: holdInState(s, item.id, 'stranded-in-composer', Date.now()), value: null }));
      expect((await readInboxState()).items[0].state).toBe('held');
      await mutateInbox((s) => ({ state: holdInState(s, item.id, 'again', Date.now()), value: null }));
      expect(seen).toEqual([`${item.id}:stranded-in-composer`]);
    } finally {
      off();
    }
  });

  it('calls onInboxHeld after the write, and a throwing listener never undoes it', async () => {
    const { enqueueNotice, mutateInbox, holdInState, onInboxHeld, readInboxState } = await load();
    const onDisk: string[] = [];
    const offRead = onInboxHeld(() => {
      readInboxState().then((s) => onDisk.push(s.items[0].state)).catch(() => onDisk.push('unreadable'));
    });
    const offThrow = onInboxHeld(() => { throw new Error('listener bug'); });
    try {
      const { item } = await enqueueNotice(req());
      await mutateInbox((s) => ({ state: holdInState(s, item.id, 'x', Date.now()), value: null }));
      await vi.waitFor(() => expect(onDisk).toEqual(['held']));
      expect((await readInboxState()).items[0].state).toBe('held');
    } finally {
      offRead();
      offThrow();
    }
  });

  it('withdraws a still-queued notice and leaves any other state alone', async () => {
    const { enqueueNotice, withdrawNotice, mutateInbox, deliverInState, readInboxState } = await load();
    const a = await enqueueNotice(req({ dedupeKey: 'a' }));
    const b = await enqueueNotice(req({ dedupeKey: 'b' }));
    await mutateInbox((s) => ({ state: deliverInState(s, b.item.id, Date.now()), value: null }));
    expect(await withdrawNotice(a.item.id, 'episode-closed')).toBe(true);
    expect(await withdrawNotice(b.item.id, 'episode-closed')).toBe(false);
    expect(await withdrawNotice('i-none', 'x')).toBe(false);
    const states = Object.fromEntries((await readInboxState()).items.map((i) => [i.dedupeKey, [i.state, i.droppedReason]]));
    expect(states).toEqual({ a: ['dropped', 'episode-closed'], b: ['delivered', null] });
  });
});
