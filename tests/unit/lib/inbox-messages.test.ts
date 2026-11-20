import { describe, expect, it } from 'vitest';
import {
  MESSAGE_QUEUE_CAP,
  MESSAGE_TTL_DEFAULT_MS,
  claimMessageInState,
  deliveryOf,
  enqueueMessageInState,
  holdClaimedMessagesInState,
  blankSpentBodies,
  inboxItemView,
  messageRequestFor,
  refuseUntypedMessagesInState,
  type IMessageEnqueue,
} from '@/lib/inbox-messages';
import {
  CLAIM_STALE_MS,
  InboxError,
  deliverInState,
  dropForTabInState,
  dueItems,
  enqueueInState,
  holdInState,
  refuseInState,
  retryInState,
  sweepInState,
  withdrawInState,
} from '@/lib/inbox-store';
import type { IInboxItem, IInboxState } from '@/types/inbox';

// ADR-0050: the inbox kind `message`, its five delivery states, supersede, TTL and cap.

const T0 = Date.parse('2026-11-20T01:00:00.000Z');

const req = (id: string, overrides: Partial<IMessageEnqueue> = {}): IMessageEnqueue => ({
  id,
  targetWorkspaceId: 'ws-A',
  targetTabId: 'tab-1',
  targetSessionName: 'pt-ws-A-pane-a-tab-1',
  fromWorkspaceId: 'ws-A',
  fromTabId: 'tab-2',
  body: `body of ${id}`,
  supersedeKey: null,
  ttlMs: MESSAGE_TTL_DEFAULT_MS,
  ...overrides,
});

const enqueue = (state: IInboxState, r: IMessageEnqueue, now = T0) => enqueueMessageInState(state, r, now).state;
const byId = (state: IInboxState, id: string): IInboxItem => state.items.find((i) => i.id === id)!;

describe('inbox message items (ADR-0050)', () => {
  it('stores the body apart from the fixed header line, which carries the id, the sender and the queue time', () => {
    const { item } = enqueueMessageInState({ items: [] }, req('i-m1'), T0);
    expect(item).toMatchObject({ kind: 'message', state: 'queued', targetWorkspaceId: 'ws-A', targetTabId: 'tab-1' });
    expect(item.line).toBe('[purplemux message i-m1 from ws-A/tab-2, queued 2026-11-20T01:00:00Z]');
    expect(item.message).toEqual({
      fromWorkspaceId: 'ws-A', fromTabId: 'tab-2', body: 'body of i-m1', targetSessionName: 'pt-ws-A-pane-a-tab-1',
      supersedeKey: null, claimedAt: null,
    });
    expect(item.expiresAt).toBe(T0 + 120 * 60_000);
  });

  it('names a sender with no tab as its workspace', () => {
    const { item } = enqueueMessageInState({ items: [] }, req('i-m1', { fromTabId: null }), T0);
    expect(item.line).toBe('[purplemux message i-m1 from ws-A/workspace, queued 2026-11-20T01:00:00Z]');
  });

  it('message-workspace-recheck (store half): refuses to queue a body whose sender workspace is not the target workspace', () => {
    expect(() => enqueueMessageInState({ items: [] }, req('i-m1', { fromWorkspaceId: 'ws-B' }), T0))
      .toThrow(expect.objectContaining({ code: 'message-workspace-mismatch' }));
  });

  it('the generic enqueue refuses the kind message: only the message path stores a body', () => {
    expect(() => enqueueInState({ items: [] }, {
      kind: 'message', targetWorkspaceId: 'ws-A', targetTabId: 'tab-1', dedupeKey: 'k',
      fields: { messageId: 'i-m1', fromWorkspaceId: 'ws-A', fromTabId: 'tab-2', queuedAt: T0 },
    }, T0, () => 'i-m1')).toThrow(InboxError);
  });

  it('message-queue-cap: the 21st queued message for one tab is refused message-queue-full; another tab is not affected', () => {
    let state: IInboxState = { items: [] };
    for (let n = 0; n < MESSAGE_QUEUE_CAP; n++) state = enqueue(state, req(`i-m${n}`));
    expect(() => enqueueMessageInState(state, req('i-over'), T0)).toThrow(expect.objectContaining({ code: 'message-queue-full' }));
    expect(() => enqueueMessageInState(state, req('i-other', { targetTabId: 'tab-9', targetSessionName: 'pt-ws-A-pane-a-tab-9' }), T0)).not.toThrow();
    const oneDelivered = deliverInState(state, 'i-m0', T0);
    expect(() => enqueueMessageInState(oneDelivered, req('i-next'), T0)).not.toThrow();
  });

  describe('supersede (adversarial case 3)', () => {
    it('supersede-race-keeps-newest: a claimed old item is delivered, the middle one is refused superseded-by the newest', () => {
      let state = enqueue({ items: [] }, req('i-old', { supersedeKey: 'taken' }));
      const claim = claimMessageInState(state, 'i-old', T0 + 1);
      expect(claim.claimed).toBe(true);
      state = claim.state;
      state = enqueue(state, req('i-mid', { supersedeKey: 'taken' }), T0 + 2);
      state = enqueue(state, req('i-new', { supersedeKey: 'taken' }), T0 + 3);
      state = deliverInState(state, 'i-old', T0 + 4);
      expect(deliveryOf(byId(state, 'i-old'))).toBe('delivered');
      expect(byId(state, 'i-mid')).toMatchObject({ state: 'dropped', droppedReason: 'superseded-by:i-new' });
      expect(deliveryOf(byId(state, 'i-mid'))).toBe('refused');
      expect(deliveryOf(byId(state, 'i-new'))).toBe('queued');
    });

    it('never supersedes a delivered or held item', () => {
      let state = enqueue({ items: [] }, req('i-a', { supersedeKey: 'k' }));
      state = enqueue(state, req('i-b', { supersedeKey: 'other' }));
      state = deliverInState(state, 'i-a', T0);
      state = holdInState(state, 'i-b', 'stranded-in-composer', T0);
      state = enqueue(state, req('i-c', { supersedeKey: 'k' }));
      state = enqueue(state, req('i-d', { supersedeKey: 'other' }));
      expect(byId(state, 'i-a').state).toBe('delivered');
      expect(byId(state, 'i-b').state).toBe('held');
    });

    it('supersede-scope-isolated: never across a target tab, a sender tab, a workspace, a key, or to an item with no key', () => {
      let state = enqueue({ items: [] }, req('i-other-target', { supersedeKey: 'k', targetTabId: 'tab-9', targetSessionName: 's9' }));
      state = enqueue(state, req('i-other-sender', { supersedeKey: 'k', fromTabId: 'tab-3' }));
      state = enqueue(state, req('i-other-ws', { supersedeKey: 'k', targetWorkspaceId: 'ws-B', fromWorkspaceId: 'ws-B' }));
      state = enqueue(state, req('i-other-key', { supersedeKey: 'j' }));
      state = enqueue(state, req('i-no-key'));
      state = enqueue(state, req('i-new', { supersedeKey: 'k' }));
      for (const id of ['i-other-target', 'i-other-sender', 'i-other-ws', 'i-other-key', 'i-no-key']) {
        expect(byId(state, id).state).toBe('queued');
      }
      const superseded = enqueueMessageInState(state, req('i-newer', { supersedeKey: 'k' }), T0).superseded;
      expect(superseded.map((i) => i.id)).toEqual(['i-new']);
    });
  });

  describe('expiry, holds and the boot pass (adversarial case 2)', () => {
    it('message-expiry-ttl: a queued message past its TTL becomes expired, never held', () => {
      const state = enqueue({ items: [] }, req('i-m1', { ttlMs: 5 * 60_000 }));
      expect(sweepInState(state, T0 + 5 * 60_000 - 1)).toBe(state);
      const swept = sweepInState(state, T0 + 5 * 60_000);
      expect(byId(swept, 'i-m1')).toMatchObject({ state: 'dropped', droppedReason: 'expired' });
      expect(deliveryOf(byId(swept, 'i-m1'))).toBe('expired');
    });

    it('a held message stays held, visible, until the 7-day prune', () => {
      const held = holdInState(enqueue({ items: [] }, req('i-m1')), 'i-m1', 'stranded-in-composer', T0);
      const later = sweepInState(held, T0 + 3 * 60 * 60_000);
      expect(deliveryOf(byId(later, 'i-m1'))).toBe('held');
      expect(sweepInState(held, T0 + 7 * 24 * 60 * 60_000).items).toEqual([]);
    });

    it('a refusal of a claimed message holds it transport-uncertain: it is never typed again blind', () => {
      let state = enqueue({ items: [] }, req('i-m1'));
      state = claimMessageInState(state, 'i-m1', T0).state;
      state = refuseInState(state, 'i-m1', 'dispatch-error:boom', T0);
      expect(byId(state, 'i-m1')).toMatchObject({ state: 'held' });
      expect(byId(state, 'i-m1').heldReason).toMatch(/^transport-uncertain/);
    });

    it('a claim is taken once: a second claim of the same item fails', () => {
      const state = enqueue({ items: [] }, req('i-m1'));
      const first = claimMessageInState(state, 'i-m1', T0);
      expect(first.claimed).toBe(true);
      expect(claimMessageInState(first.state, 'i-m1', T0).claimed).toBe(false);
    });

    it('message-crash-after-claim-held: the boot pass holds every claimed, undelivered message transport-uncertain', () => {
      let state = enqueue({ items: [] }, req('i-claimed'));
      state = enqueue(state, req('i-waiting'));
      state = claimMessageInState(state, 'i-claimed', T0).state;
      const { state: booted, held } = holdClaimedMessagesInState(state, T0 + 1);
      expect(held.map((i) => i.id)).toEqual(['i-claimed']);
      expect(byId(booted, 'i-claimed')).toMatchObject({ state: 'held', heldReason: 'transport-uncertain:server-stopped' });
      expect(byId(booted, 'i-waiting').state).toBe('queued');
    });

    it('a retry of a held message that was claimed is refused', () => {
      let state = enqueue({ items: [] }, req('i-m1'));
      state = claimMessageInState(state, 'i-m1', T0).state;
      state = holdClaimedMessagesInState(state, T0).state;
      expect(() => retryInState(state, 'i-m1', T0)).toThrow(expect.objectContaining({ code: 'inbox-not-held' }));
    });

    it('tab-closed-drops-messages (store half): a closed tab refuses its queued and held messages target-tab-closed', () => {
      let state = enqueue({ items: [] }, req('i-q'));
      state = holdInState(enqueue(state, req('i-h')), 'i-h', 'stranded-in-composer', T0);
      state = dropForTabInState(state, 'ws-A', 'tab-1', 'target-tab-closed', T0).state;
      for (const id of ['i-q', 'i-h']) {
        expect(byId(state, id)).toMatchObject({ state: 'dropped', droppedReason: 'target-tab-closed' });
        expect(deliveryOf(byId(state, id))).toBe('refused');
      }
    });

    it('switch-off-refuses-queued (store half): every queued message and every unclaimed hold is refused queue-off; claimed and other kinds are kept', () => {
      let state = enqueue({ items: [] }, req('i-q'));
      state = enqueue(state, req('i-c'));
      state = claimMessageInState(state, 'i-c', T0).state;
      state = holdInState(enqueue(state, req('i-h')), 'i-h', 'target-not-agent', T0);
      state = enqueueInState(state, { kind: 'resume', targetWorkspaceId: 'ws-A', targetTabId: 'tab-1', dedupeKey: 'r', fields: { resumeId: 'r-abcd12' } }, T0, () => 'i-r').state;
      const { state: off, refused } = refuseUntypedMessagesInState(state, 'queue-off', T0);
      expect(refused.map((i) => i.id)).toEqual(['i-q', 'i-h']);
      expect(byId(off, 'i-q')).toMatchObject({ state: 'dropped', droppedReason: 'queue-off' });
      expect(byId(off, 'i-h')).toMatchObject({ state: 'dropped', droppedReason: 'queue-off' });
      expect(byId(off, 'i-c').state).toBe('queued');
      expect(byId(off, 'i-r').state).toBe('queued');
    });
  });

  describe('delivery-state-mapping (the message half)', () => {
    it('maps the stored states to the five delivery states', () => {
      let state = enqueue({ items: [] }, req('i-q'));
      state = deliverInState(enqueue(state, req('i-d')), 'i-d', T0);
      state = holdInState(enqueue(state, req('i-h')), 'i-h', 'stranded-in-composer', T0);
      state = withdrawInState(enqueue(state, req('i-r')), 'i-r', 'policy:refused', T0);
      state = sweepInState(enqueue(state, req('i-e', { ttlMs: 1 })), T0 + 1);
      expect(['i-q', 'i-d', 'i-h', 'i-r', 'i-e'].map((id) => deliveryOf(byId(state, id))))
        .toEqual(['queued', 'delivered', 'held', 'refused', 'expired']);
    });

    it('a view never carries the body; it names the delivery state and the body size', () => {
      const { item } = enqueueMessageInState({ items: [] }, req('i-m1', { body: 'secret plan' }), T0);
      const view = inboxItemView(item);
      expect(JSON.stringify(view)).not.toContain('secret plan');
      expect(view).toMatchObject({ id: 'i-m1', delivery: 'queued', message: { bodyBytes: 11, fromTabId: 'tab-2', supersedeKey: null, claimedAt: null } });
    });
  });

  describe('FIFO per target tab (adversarial case 1)', () => {
    it('message-fifo-per-target: one message per tab is due at a time, oldest first', () => {
      let state = enqueue({ items: [] }, req('i-first'), T0);
      state = enqueue(state, req('i-second'), T0 + 1);
      expect(dueItems(state, T0 + 2, () => false).map((i) => i.id)).toEqual(['i-first']);
      state = deliverInState(state, 'i-first', T0 + 3);
      expect(dueItems(state, T0 + 4, () => false).map((i) => i.id)).toEqual(['i-second']);
    });

    it('a waiting notice of another kind does not block a message to the same tab, nor the reverse', () => {
      let state = enqueueInState({ items: [] }, { kind: 'resume', targetWorkspaceId: 'ws-A', targetTabId: 'tab-1', dedupeKey: 'r', fields: { resumeId: 'r-abcd12' } }, T0, () => 'i-r').state;
      state = enqueue(state, req('i-m'), T0 + 1);
      expect(dueItems(state, T0 + 2, () => false).map((i) => i.id).sort()).toEqual(['i-m', 'i-r']);
    });
  });

  describe('no body outlives the chance to type it (review B3)', () => {
    it('spent-body-blanked: every final state and every claimed hold keeps an empty body; a queued item and an unclaimed hold keep theirs', () => {
      let state = enqueue({ items: [] }, req('i-queued'));
      state = deliverInState(enqueue(state, req('i-delivered')), 'i-delivered', T0);
      state = withdrawInState(enqueue(state, req('i-refused')), 'i-refused', 'policy:refused', T0);
      state = sweepInState(enqueue(state, req('i-expired', { ttlMs: 1 })), T0 + 1);
      state = holdInState(enqueue(state, req('i-held-free')), 'i-held-free', 'target-not-agent', T0);
      state = claimMessageInState(enqueue(state, req('i-held-claimed')), 'i-held-claimed', T0).state;
      state = holdInState(state, 'i-held-claimed', 'stranded-in-composer', T0);
      const blanked = blankSpentBodies(state);
      const body = (id: string) => byId(blanked, id).message!.body;
      expect(['i-delivered', 'i-refused', 'i-expired', 'i-held-claimed'].map(body)).toEqual(['', '', '', '']);
      expect(body('i-queued')).toBe('body of i-queued');
      expect(body('i-held-free')).toBe('body of i-held-free');
      expect(blankSpentBodies(blanked)).toBe(blanked);
    });

    it('a view of a blanked item names a body size of 0', () => {
      const delivered = blankSpentBodies(deliverInState(enqueue({ items: [] }, req('i-m1')), 'i-m1', T0));
      expect(inboxItemView(byId(delivered, 'i-m1'))).toMatchObject({ delivery: 'delivered', message: { bodyBytes: 0 } });
    });
  });

  it('a queued message still claimed after its attempt is held transport-uncertain, never expired (review N5)', () => {
    let state = enqueue({ items: [] }, req('i-m1', { ttlMs: 60_000 }));
    state = claimMessageInState(state, 'i-m1', T0).state;
    expect(byId(sweepInState(state, T0 + 1), 'i-m1').state).toBe('queued');
    expect(byId(sweepInState(state, T0 + 60_000), 'i-m1').state).toBe('queued');
    const swept = sweepInState(state, T0 + CLAIM_STALE_MS);
    expect(byId(swept, 'i-m1')).toMatchObject({ state: 'held', heldReason: 'transport-uncertain:outcome-unrecorded' });
  });

  it('messageRequestFor takes the sender workspace from the caller scope, never the target (review N1)', () => {
    const request = messageRequestFor({
      scope: { workspaceId: 'ws-B' }, senderTabId: 'tab-9', targetWorkspaceId: 'ws-A', targetTabId: 'tab-1', targetSessionName: 's',
      body: 'x', supersedeKey: null, ttlMin: 5,
    });
    expect(request).toMatchObject({ fromWorkspaceId: 'ws-B', fromTabId: 'tab-9', targetWorkspaceId: 'ws-A', ttlMs: 300_000 });
    expect(() => enqueueMessageInState({ items: [] }, { ...request, id: 'i-m1' }, T0)).toThrow(expect.objectContaining({ code: 'message-workspace-mismatch' }));
  });
});
