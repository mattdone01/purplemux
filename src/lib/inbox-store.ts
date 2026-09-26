import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { nanoid } from 'nanoid';
import { renderInboxLine, type IInboxFields } from '@/lib/inbox-templates';
import type { IInboxItem, IInboxState, TInboxErrorCode, TInboxKind } from '@/types/inbox';

export class InboxError extends Error {
  constructor(readonly code: TInboxErrorCode, message: string) {
    super(message);
  }
}

export const INBOX_MAX_REFUSALS = 30;
export const INBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const INBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BACKOFF_MS = [10_000, 30_000, 120_000, 300_000];

/** 10 s → 30 s → 2 min → 5 min, then 5 min: the wait after the nth refusal. */
export const backoffAfter = (refusals: number): number =>
  BACKOFF_MS[Math.min(Math.max(refusals, 1), BACKOFF_MS.length) - 1];

// ─── pure state transitions ──────────────────────────────────────────────

export interface IEnqueueRequest<K extends TInboxKind = TInboxKind> {
  kind: K;
  targetWorkspaceId: string;
  targetTabId: string;
  dedupeKey: string;
  fields: IInboxFields[K];
}

const TARGET_WORKSPACE = /^ws-[A-Za-z0-9_-]{1,32}$/;
const TARGET_TAB = /^tab-[A-Za-z0-9_-]{1,32}$/;

export const enqueueInState = <K extends TInboxKind>(
  state: IInboxState,
  req: IEnqueueRequest<K>,
  now: number,
  newId: () => string,
): { state: IInboxState; item: IInboxItem; created: boolean } => {
  if (!TARGET_WORKSPACE.test(req.targetWorkspaceId) || !TARGET_TAB.test(req.targetTabId)) {
    throw new InboxError('inbox-field-invalid', 'inbox target must be a workspace id and a tab id');
  }
  if (typeof req.dedupeKey !== 'string' || !req.dedupeKey || req.dedupeKey.length > 200) {
    throw new InboxError('inbox-field-invalid', 'inbox dedupeKey must be 1-200 characters');
  }
  const { line } = renderInboxLine(req.kind, req.fields);
  // Per target: one key may be queued once for each recipient (a broadcast).
  const existing = state.items.find((i) => i.state === 'queued' && i.dedupeKey === req.dedupeKey
    && i.targetWorkspaceId === req.targetWorkspaceId && i.targetTabId === req.targetTabId);
  if (existing) return { state, item: existing, created: false };
  const item: IInboxItem = {
    id: newId(),
    kind: req.kind,
    targetWorkspaceId: req.targetWorkspaceId,
    targetTabId: req.targetTabId,
    dedupeKey: req.dedupeKey,
    line,
    createdAt: now,
    notBefore: now,
    attempts: 0,
    lastAttemptAt: null,
    lastRefusal: null,
    state: 'queued',
    deliveredAt: null,
    heldReason: null,
    droppedReason: null,
    expiresAt: now + INBOX_MAX_AGE_MS,
    transitionAt: now,
  };
  return { state: { items: [...state.items, item] }, item, created: true };
};

const replace = (state: IInboxState, id: string, fn: (item: IInboxItem) => IInboxItem): IInboxState => ({
  items: state.items.map((i) => (i.id === id ? fn(i) : i)),
});

const hold = (item: IInboxItem, reason: string, now: number): IInboxItem =>
  ({ ...item, state: 'held', heldReason: reason, transitionAt: now });

/** One refusal: back off, or hold after the 30th refusal or past 24 h. */
export const refuseInState = (state: IInboxState, id: string, reason: string, now: number): IInboxState =>
  replace(state, id, (item) => {
    if (item.state !== 'queued') return item;
    const attempts = item.attempts + 1;
    const refused = { ...item, attempts, lastAttemptAt: now, lastRefusal: reason, notBefore: now + backoffAfter(attempts) };
    if (attempts >= INBOX_MAX_REFUSALS) return hold(refused, `${reason} (${attempts} refusals)`, now);
    if (now >= item.expiresAt) return hold(refused, `${reason} (undelivered after 24 h)`, now);
    return refused;
  });

export const deliverInState = (state: IInboxState, id: string, now: number): IInboxState =>
  replace(state, id, (item) => (item.state === 'queued'
    ? { ...item, state: 'delivered', deliveredAt: now, lastAttemptAt: now, transitionAt: now }
    : item));

export const holdInState = (state: IInboxState, id: string, reason: string, now: number): IInboxState =>
  replace(state, id, (item) => (item.state === 'queued' ? hold({ ...item, lastAttemptAt: now }, reason, now) : item));

export const dropForTabInState = (
  state: IInboxState,
  workspaceId: string,
  tabId: string,
  reason: string,
  now: number,
): { state: IInboxState; dropped: IInboxItem[] } => {
  const dropped: IInboxItem[] = [];
  const items = state.items.map((item) => {
    if (item.targetWorkspaceId !== workspaceId || item.targetTabId !== tabId) return item;
    if (item.state !== 'queued' && item.state !== 'held') return item;
    const next: IInboxItem = { ...item, state: 'dropped', droppedReason: reason, transitionAt: now };
    dropped.push(next);
    return next;
  });
  return { state: { items }, dropped };
};

/**
 * Queued items past 24 h become held; terminal items 7 days after their last
 * transition are pruned. The same state object comes back when nothing
 * changed, so a quiet tick writes nothing.
 */
export const sweepInState = (state: IInboxState, now: number): IInboxState => {
  let changed = false;
  const items: IInboxItem[] = [];
  for (const item of state.items) {
    if (item.state !== 'queued' && now - item.transitionAt >= INBOX_RETENTION_MS) {
      changed = true;
      continue;
    }
    if (item.state === 'queued' && now >= item.expiresAt) {
      changed = true;
      items.push(hold(item, `${item.lastRefusal ?? 'never ready'} (undelivered after 24 h)`, now));
      continue;
    }
    items.push(item);
  }
  return changed ? { items } : state;
};

/** Drop the queued and held items of every tab `isGone` confirms closed (the boot pass). */
export const dropGoneTargetsInState = (
  state: IInboxState,
  isGone: (workspaceId: string, tabId: string) => boolean,
  now: number,
): { state: IInboxState; dropped: IInboxItem[] } => {
  const dropped: IInboxItem[] = [];
  const items = state.items.map((item) => {
    if ((item.state !== 'queued' && item.state !== 'held') || !isGone(item.targetWorkspaceId, item.targetTabId)) return item;
    const next: IInboxItem = { ...item, state: 'dropped', droppedReason: 'target-tab-closed', transitionAt: now };
    dropped.push(next);
    return next;
  });
  return { state: dropped.length ? { items } : state, dropped };
};

/** A held item goes back to the queue once per call, with a fresh budget. */
export const retryInState = (state: IInboxState, id: string, now: number): { state: IInboxState; item: IInboxItem } => {
  const item = state.items.find((i) => i.id === id);
  if (!item) throw new InboxError('inbox-not-found', `inbox item ${id} not found`);
  if (item.state !== 'held') throw new InboxError('inbox-not-held', `inbox item ${id} is ${item.state}, not held`);
  const newer = state.items.find((i) => i.id !== id && i.state === 'queued' && i.dedupeKey === item.dedupeKey
    && i.targetWorkspaceId === item.targetWorkspaceId && i.targetTabId === item.targetTabId);
  if (newer) throw new InboxError('inbox-not-held', `a newer notice with this key is already queued: ${newer.id}`);
  const next: IInboxItem = {
    ...item,
    state: 'queued',
    attempts: 0,
    notBefore: now,
    heldReason: null,
    expiresAt: now + INBOX_MAX_AGE_MS,
    transitionAt: now,
  };
  return { state: replace(state, id, () => next), item: next };
};

/**
 * The next item per target tab, oldest first: due by its backoff, or woken
 * early by `wake` (the tab became ready after a state refusal).
 */
export const dueItems = (state: IInboxState, now: number, wake: (item: IInboxItem) => boolean): IInboxItem[] => {
  const byTab = new Map<string, IInboxItem>();
  const queued = state.items.filter((i) => i.state === 'queued').sort((a, b) => a.createdAt - b.createdAt);
  for (const item of queued) {
    const key = `${item.targetWorkspaceId}/${item.targetTabId}`;
    if (byTab.has(key)) continue;
    // Per tab, strictly in order: a later notice never overtakes a waiting one.
    byTab.set(key, item);
  }
  return [...byTab.values()].filter((item) => item.notBefore <= now || wake(item));
};

// ─── I/O ─────────────────────────────────────────────────────────────────

const g = globalThis as unknown as { __ptInboxLock?: Promise<void> };
if (!g.__ptInboxLock) g.__ptInboxLock = Promise.resolve();

export const inboxFile = (): string => path.join(os.homedir(), '.purplemux', 'inbox.json');

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g.__ptInboxLock!;
  g.__ptInboxLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const isItem = (value: unknown): value is IInboxItem => {
  if (!value || typeof value !== 'object') return false;
  const i = value as Record<string, unknown>;
  return typeof i.id === 'string' && typeof i.kind === 'string' && typeof i.line === 'string'
    && typeof i.targetWorkspaceId === 'string' && typeof i.targetTabId === 'string' && typeof i.state === 'string';
};

/** Absent file = empty inbox; a file that is not `{ items: [...] }` is refused, not read as empty. */
export const readInboxState = async (): Promise<IInboxState> => {
  const file = inboxFile();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { items: [] };
    throw err;
  }
  const items = (JSON.parse(raw) as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error(`${file} has no "items" array; the inbox is refused until it is repaired or moved aside`);
  // A malformed entry is refused, not skipped: the next write would erase it for good.
  const bad = items.findIndex((item) => !isItem(item));
  if (bad !== -1) throw new Error(`${file} item ${bad} is malformed; the inbox is refused until it is repaired or moved aside`);
  return { items: items as IInboxItem[] };
};

const writeInboxState = async (state: IInboxState): Promise<void> => {
  const file = inboxFile();
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
};

/** Read, transform, write under the one inbox lock. */
export const mutateInbox = async <T>(fn: (state: IInboxState) => { state: IInboxState; value: T }): Promise<T> =>
  withLock(async () => {
    const before = await readInboxState();
    const { state, value } = fn(before);
    if (state !== before) await writeInboxState(state);
    return value;
  });

export const newInboxId = (): string => `i-${nanoid(10)}`;

/**
 * The ONLY entry point for a server-originated notice. The owning feature has
 * already decided the sender may notify this tab; the inbox renders the line
 * from the kind's fixed template and queues it. A `dedupeKey` still queued
 * returns the existing item.
 */
export const enqueueNotice = async <K extends TInboxKind>(req: IEnqueueRequest<K>): Promise<{ item: IInboxItem; created: boolean }> =>
  mutateInbox((state) => {
    const result = enqueueInState(state, req, Date.now(), newInboxId);
    return { state: result.state, value: { item: result.item, created: result.created } };
  });
