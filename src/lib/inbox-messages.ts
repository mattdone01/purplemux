import { InboxError, TRANSPORT_UNCERTAIN, mutateInbox, newInboxId } from '@/lib/inbox-store';
import { renderInboxLine } from '@/lib/inbox-templates';
import type { IInboxItem, IInboxMessage, IInboxState, TDeliveryState } from '@/types/inbox';

// The inbox kind `message` (ADR-0050): a `tab send` body queued for a busy Claude tab, its delivery states, its
// supersede key, its TTL and its cap. Pure transitions; the I/O wrapper at the end runs them under the inbox lock.

export const MESSAGE_TTL_DEFAULT_MIN = 120;
export const MESSAGE_TTL_MAX_MIN = 1440;
export const MESSAGE_TTL_DEFAULT_MS = MESSAGE_TTL_DEFAULT_MIN * 60_000;
/** Queued messages one target tab may hold; the next send is refused `message-queue-full`. */
export const MESSAGE_QUEUE_CAP = 20;
export const SUPERSEDE_KEY = /^[A-Za-z0-9._:-]{1,64}$/;

export interface IMessageEnqueue {
  id: string;
  targetWorkspaceId: string;
  targetTabId: string;
  targetSessionName: string;
  fromWorkspaceId: string;
  fromTabId: string | null;
  body: string;
  supersedeKey: string | null;
  ttlMs: number;
}

const supersedes = (newer: IMessageEnqueue, older: IInboxItem): boolean =>
  newer.supersedeKey !== null && older.kind === 'message' && older.state === 'queued' && older.message?.claimedAt === null
  && older.targetWorkspaceId === newer.targetWorkspaceId && older.targetTabId === newer.targetTabId
  && older.message.fromWorkspaceId === newer.fromWorkspaceId && older.message.fromTabId === newer.fromTabId
  && older.message.supersedeKey === newer.supersedeKey;

const isQueuedMessageFor = (item: IInboxItem, workspaceId: string, tabId: string): boolean =>
  item.kind === 'message' && item.state === 'queued' && item.targetWorkspaceId === workspaceId && item.targetTabId === tabId;

/**
 * Queue one message, under the inbox lock. A body crosses no workspace (the ADR-0012 amendment): a sender of another
 * workspace is refused here as well as at the route and again before the paste. A queued, unclaimed item of the same
 * target, sender tab and key is refused `superseded-by:<id>`; a claimed, delivered or held one is never touched, since
 * its text may already be on the screen. Then the cap counts what is still queued.
 */
export const enqueueMessageInState = (
  state: IInboxState,
  req: IMessageEnqueue,
  now: number,
): { state: IInboxState; item: IInboxItem; superseded: IInboxItem[] } => {
  if (req.fromWorkspaceId !== req.targetWorkspaceId) {
    throw new InboxError('message-workspace-mismatch', 'a message body is queued only inside its sender\'s own workspace');
  }
  if (req.supersedeKey !== null && !SUPERSEDE_KEY.test(req.supersedeKey)) {
    throw new InboxError('inbox-field-invalid', `supersede key must match ${SUPERSEDE_KEY.source}`);
  }
  const { line } = renderInboxLine('message', {
    messageId: req.id, fromWorkspaceId: req.fromWorkspaceId, fromTabId: req.fromTabId, queuedAt: now,
  });
  const superseded: IInboxItem[] = [];
  const items = state.items.map((item) => {
    if (!supersedes(req, item)) return item;
    const next: IInboxItem = { ...item, state: 'dropped', droppedReason: `superseded-by:${req.id}`, transitionAt: now };
    superseded.push(next);
    return next;
  });
  const queued = items.filter((item) => isQueuedMessageFor(item, req.targetWorkspaceId, req.targetTabId)).length;
  if (queued >= MESSAGE_QUEUE_CAP) {
    throw new InboxError('message-queue-full', `the message queue of tab ${req.targetTabId} is full (${MESSAGE_QUEUE_CAP} queued)`);
  }
  const message: IInboxMessage = {
    fromWorkspaceId: req.fromWorkspaceId,
    fromTabId: req.fromTabId,
    body: req.body,
    targetSessionName: req.targetSessionName,
    supersedeKey: req.supersedeKey,
    claimedAt: null,
  };
  const item: IInboxItem = {
    id: req.id,
    kind: 'message',
    targetWorkspaceId: req.targetWorkspaceId,
    targetTabId: req.targetTabId,
    dedupeKey: `message:${req.id}`,
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
    expiresAt: now + req.ttlMs,
    staleAt: null,
    transitionAt: now,
    message,
  };
  return { state: { items: [...items, item] }, item, superseded };
};

/** True when the item was queued and unclaimed, and is now claimed by this call. */
export const claimMessageInState = (state: IInboxState, id: string, now: number): { state: IInboxState; claimed: boolean } => {
  const item = state.items.find((i) => i.id === id);
  if (!item || item.kind !== 'message' || item.state !== 'queued' || !item.message || item.message.claimedAt !== null) {
    return { state, claimed: false };
  }
  const claimed: IInboxItem = { ...item, message: { ...item.message, claimedAt: now } };
  return { state: { items: state.items.map((i) => (i.id === id ? claimed : i)) }, claimed: true };
};

/** The boot pass: a message claimed when the server stopped may be on the screen, so it is held, never typed blind. */
export const holdClaimedMessagesInState = (state: IInboxState, now: number): { state: IInboxState; held: IInboxItem[] } => {
  const held: IInboxItem[] = [];
  const items = state.items.map((item) => {
    if (item.kind !== 'message' || item.state !== 'queued' || item.message?.claimedAt == null) return item;
    const next: IInboxItem = { ...item, state: 'held', heldReason: `${TRANSPORT_UNCERTAIN}server-stopped`, transitionAt: now };
    held.push(next);
    return next;
  });
  return { state: held.length ? { items } : state, held };
};

/** The switch `tab-send.queue` is off: every queued, unclaimed message is refused with `reason` (ADR-0050 rollback). */
export const refuseQueuedMessagesInState = (state: IInboxState, reason: string, now: number): { state: IInboxState; refused: IInboxItem[] } => {
  const refused: IInboxItem[] = [];
  const items = state.items.map((item) => {
    if (item.kind !== 'message' || item.state !== 'queued' || item.message?.claimedAt !== null) return item;
    const next: IInboxItem = { ...item, state: 'dropped', droppedReason: reason, transitionAt: now };
    refused.push(next);
    return next;
  });
  return { state: refused.length ? { items } : state, refused };
};

export const hasQueuedMessageFor = (state: IInboxState, workspaceId: string, tabId: string): boolean =>
  state.items.some((item) => isQueuedMessageFor(item, workspaceId, tabId));

export const deliveryOf = (item: Pick<IInboxItem, 'state' | 'droppedReason'>): TDeliveryState => {
  if (item.state === 'dropped') return item.droppedReason === 'expired' ? 'expired' : 'refused';
  return item.state;
};

export type TInboxItemView = Omit<IInboxItem, 'message'> & {
  delivery: TDeliveryState;
  message?: Omit<IInboxMessage, 'body'> & { bodyBytes: number };
};

/**
 * What `inbox list` and `inbox show` return. A message body is caller text: it is typed into its own workspace and is
 * never served back, so a workspace that may only read this inbox learns its size, never its words.
 */
export const inboxItemView = (item: IInboxItem): TInboxItemView => {
  const { message, ...rest } = item;
  if (!message) return { ...rest, delivery: deliveryOf(item) };
  const { body, ...meta } = message;
  return { ...rest, delivery: deliveryOf(item), message: { ...meta, bodyBytes: Buffer.byteLength(body, 'utf8') } };
};

/** Queue a message under the inbox lock; the id is made here so the header can carry it. */
export const enqueueMessage = async (req: Omit<IMessageEnqueue, 'id'>): Promise<{ item: IInboxItem; superseded: IInboxItem[] }> =>
  mutateInbox((state) => {
    const result = enqueueMessageInState(state, { ...req, id: newInboxId() }, Date.now());
    return { state: result.state, value: { item: result.item, superseded: result.superseded } };
  });
