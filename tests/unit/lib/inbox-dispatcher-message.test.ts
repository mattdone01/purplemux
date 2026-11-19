import { describe, expect, it, vi } from 'vitest';
import { InboxDispatcher, type IInboxDispatcherDeps } from '@/lib/inbox-dispatcher';
import { MESSAGE_TTL_DEFAULT_MS, claimMessageInState, deliveryOf, enqueueMessageInState } from '@/lib/inbox-messages';
import type { IInboxState } from '@/types/inbox';
import type { IClientTabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';

// RULING.md design 5-11: the dispatcher types a queued `message` into a busy Claude tab at an empty composer.

const T0 = Date.parse('2026-11-20T01:00:00.000Z');
const EMPTY_CLAUDE = 'output\n────────\n❯ \n────────\n';
const TYPED_CLAUDE = 'output\n────────\n❯ half a sentence\n────────\n';
const SESSION = 'pt-ws-A-pane-a-tab-1';

interface IWorld {
  clock: number;
  state: IInboxState;
  cliState: TCliState;
  pane: string | null;
  sessionName: string;
  tabPresent: boolean;
  gone: boolean | null;
  alive: boolean;
  policy: { ok: boolean; error?: string };
  permission: boolean;
  startupPrompt: boolean;
  compacting: boolean;
  halted: boolean;
  /** How many reads of the composer still show the typed text after the paste. */
  pendingReads: number;
  queueOn: boolean;
}

const setup = (overrides: Partial<IWorld> = {}) => {
  const world: IWorld = {
    clock: T0, state: { items: [] }, cliState: 'busy', pane: EMPTY_CLAUDE, sessionName: SESSION, tabPresent: true, gone: true,
    alive: true, policy: { ok: true }, permission: false, startupPrompt: false, compacting: false, halted: false, pendingReads: 0,
    queueOn: true, ...overrides,
  };
  const typed: string[] = [];
  const enters: string[] = [];
  const recorded: string[] = [];
  const deps: IInboxDispatcherDeps = {
    now: () => world.clock,
    mutate: async (fn) => {
      const { state, value } = fn(world.state);
      world.state = state;
      return value;
    },
    findTab: async (): Promise<ITab | null> => (world.tabPresent ? { id: 'tab-1', name: 'w', order: 0, sessionName: world.sessionName, panelType: 'claude-code' } : null),
    tabGone: async () => world.gone,
    hasSession: async () => world.alive,
    status: () => ({
      cliState: world.cliState,
      permissionRequest: world.permission ? { id: 'p' } : null,
      startupPrompt: world.startupPrompt ? { kind: 'folder-trust', since: T0 } : null,
      compactingSince: world.compacting ? T0 : null,
      turnEnd: null,
    } as unknown as IClientTabStatusEntry),
    waitingAtPrompt: () => false,
    halted: () => world.halted,
    capture: async () => world.pane,
    withDispatchLock: async (_ws, _tab, work) => work(async () => world.policy as never),
    deliver: async (_session, text) => { typed.push(text); },
    isPending: async () => {
      if (world.pendingReads <= 0) return false;
      world.pendingReads--;
      return true;
    },
    pressEnter: async (session) => { enters.push(session); },
    recordDelivered: (item) => { recorded.push(item.id); },
    messageQueueEnabled: async () => world.queueOn,
  };
  const dispatcher = new InboxDispatcher(deps);
  const enqueue = (id: string, overrides: Record<string, unknown> = {}) => {
    world.state = enqueueMessageInState(world.state, {
      id, targetWorkspaceId: 'ws-A', targetTabId: 'tab-1', targetSessionName: SESSION, fromWorkspaceId: 'ws-A', fromTabId: 'tab-2',
      body: `please rebase ${id}`, supersedeKey: null, ttlMs: MESSAGE_TTL_DEFAULT_MS, ...overrides,
    }, world.clock).state;
  };
  const item = (id: string) => world.state.items.find((i) => i.id === id)!;
  return { world, dispatcher, typed, enters, recorded, enqueue, item };
};

describe('inbox dispatcher: the kind message (RULING.md)', () => {
  it('message-typed-busy-empty-composer: types the header line and the body, unchanged, into a busy tab at an empty composer', async () => {
    const { dispatcher, typed, enqueue, item, recorded } = setup({ cliState: 'busy' });
    enqueue('i-m1');
    await dispatcher.tick();
    expect(typed).toEqual(['[purplemux message i-m1 from ws-A/tab-2, queued 2026-11-20T01:00:00Z]\nplease rebase i-m1']);
    expect(item('i-m1')).toMatchObject({ state: 'delivered' });
    expect(deliveryOf(item('i-m1'))).toBe('delivered');
    expect(recorded).toEqual(['i-m1']);
  });

  it.each<TCliState>(['idle', 'ready-for-review'])('types into a %s tab at an empty composer', async (cliState) => {
    const { dispatcher, typed, enqueue } = setup({ cliState });
    enqueue('i-m1');
    await dispatcher.tick();
    expect(typed).toHaveLength(1);
  });

  it.each([
    ['needs-input', { cliState: 'needs-input' as TCliState }],
    ['a permission prompt', { permission: true }],
    ['a startup prompt', { cliState: 'startup-prompt' as TCliState, startupPrompt: true }],
    ['a compaction', { compacting: true }],
    ['a usage-limit halt', { halted: true }],
    ['a composer that holds text', { pane: TYPED_CLAUDE }],
    ['an unreadable pane', { pane: null }],
    ['an inactive agent', { cliState: 'inactive' as TCliState }],
  ])('types nothing on %s, and the item stays queued', async (_label, overrides) => {
    const { dispatcher, typed, enqueue, item } = setup(overrides as Partial<IWorld>);
    enqueue('i-m1');
    await dispatcher.tick();
    expect(typed).toEqual([]);
    expect(item('i-m1')).toMatchObject({ state: 'queued', attempts: 1 });
  });

  it('presses Enter once more when the text is still in the composer, and is delivered when it then leaves', async () => {
    const { dispatcher, enters, enqueue, item } = setup({ pendingReads: 1 });
    enqueue('i-m1');
    await dispatcher.tick();
    expect(enters).toEqual([SESSION]);
    expect(item('i-m1').state).toBe('delivered');
  });

  it('holds stranded-in-composer when the text is still there after the second Enter, and never types it again', async () => {
    const { dispatcher, typed, enters, enqueue, item, world } = setup({ pendingReads: 2 });
    enqueue('i-m1');
    await dispatcher.tick();
    expect(enters).toHaveLength(1);
    expect(item('i-m1')).toMatchObject({ state: 'held', heldReason: 'stranded-in-composer' });
    world.clock += 60 * 60_000;
    await dispatcher.tick();
    expect(typed).toHaveLength(1);
  });

  it('message-workspace-recheck: a stored item whose workspaces differ is refused before the paste and never typed', async () => {
    const { dispatcher, typed, enqueue, item, world } = setup();
    enqueue('i-m1');
    world.state = { items: world.state.items.map((i) => ({ ...i, message: { ...i.message!, fromWorkspaceId: 'ws-B' } })) };
    await dispatcher.tick();
    expect(typed).toEqual([]);
    expect(item('i-m1')).toMatchObject({ state: 'dropped', droppedReason: 'workspace-mismatch' });
    expect(deliveryOf(item('i-m1'))).toBe('refused');
  });

  it('message-claim-once: two ticks that race the same item paste it once', async () => {
    const { dispatcher, typed, enqueue, world } = setup();
    enqueue('i-m1');
    const second = new InboxDispatcher({
      ...((dispatcher as unknown as { deps: IInboxDispatcherDeps }).deps),
    });
    await Promise.all([dispatcher.tick(), second.tick()]);
    expect(typed).toHaveLength(1);
    expect(world.state.items[0].state).toBe('delivered');
  });

  it('a claimed item is not typed by a tick that picked it before the claim', async () => {
    const { dispatcher, typed, enqueue, world, item } = setup();
    enqueue('i-m1');
    world.state = claimMessageInState(world.state, 'i-m1', T0).state;
    await dispatcher.tick();
    expect(typed).toEqual([]);
    expect(item('i-m1').state).toBe('queued');
  });

  it('message-fifo-per-target: the second message waits for the first and is typed after it', async () => {
    const { dispatcher, typed, enqueue, world } = setup({ pane: TYPED_CLAUDE });
    enqueue('i-first');
    world.clock += 1;
    enqueue('i-second');
    await dispatcher.tick();
    expect(typed).toEqual([]);
    world.pane = EMPTY_CLAUDE;
    world.clock += 15_000;
    await dispatcher.tick();
    await dispatcher.tick();
    expect(typed.map((t) => t.split(' ')[2])).toEqual(['i-first', 'i-second']);
  });

  it('message-target-changed-refused: a replaced tmux session refuses the item target-changed, never typed', async () => {
    const { dispatcher, typed, enqueue, item, world } = setup();
    enqueue('i-m1');
    world.sessionName = 'pt-ws-A-pane-a-tab-1-new';
    await dispatcher.tick();
    expect(typed).toEqual([]);
    expect(item('i-m1')).toMatchObject({ state: 'dropped', droppedReason: 'target-changed' });
    expect(deliveryOf(item('i-m1'))).toBe('refused');
  });

  it('a policy refusal is final: the item is refused policy and never typed', async () => {
    const { dispatcher, typed, enqueue, item } = setup({ policy: { ok: false, error: 'model-mismatch' } });
    enqueue('i-m1');
    await dispatcher.tick();
    expect(typed).toEqual([]);
    expect(item('i-m1')).toMatchObject({ state: 'dropped', droppedReason: 'policy:model-mismatch' });
  });

  it('message-session-dead-expires: an exited agent in an open tab keeps the item queued with backoff, then it expires', async () => {
    const { dispatcher, typed, enqueue, item, world } = setup({ alive: false });
    enqueue('i-m1', { ttlMs: 10 * 60_000 });
    await dispatcher.tick();
    expect(item('i-m1')).toMatchObject({ state: 'queued', lastRefusal: 'session-not-running' });
    world.clock += 10 * 60_000;
    await dispatcher.tick();
    expect(typed).toEqual([]);
    expect(item('i-m1')).toMatchObject({ state: 'dropped', droppedReason: 'expired' });
    expect(deliveryOf(item('i-m1'))).toBe('expired');
  });

  it('tab-closed-drops-messages: the live close and the boot pass refuse the items target-tab-closed', async () => {
    const live = setup();
    live.enqueue('i-m1');
    await live.dispatcher.dropForTab('ws-A', 'tab-1');
    expect(live.item('i-m1')).toMatchObject({ state: 'dropped', droppedReason: 'target-tab-closed' });

    const boot = setup();
    boot.enqueue('i-m2');
    await boot.dispatcher.dropGoneTargets(() => true);
    expect(boot.item('i-m2')).toMatchObject({ state: 'dropped', droppedReason: 'target-tab-closed' });

    const missing = setup({ tabPresent: false, gone: true });
    missing.enqueue('i-m3');
    await missing.dispatcher.tick();
    expect(missing.item('i-m3')).toMatchObject({ state: 'dropped', droppedReason: 'target-tab-closed' });
  });

  it('message-crash-after-claim-held: the boot pass holds a claimed item transport-uncertain', async () => {
    const { dispatcher, enqueue, item, world, typed } = setup();
    enqueue('i-m1');
    world.state = claimMessageInState(world.state, 'i-m1', T0).state;
    await dispatcher.holdClaimedMessages();
    expect(item('i-m1')).toMatchObject({ state: 'held', heldReason: 'transport-uncertain:server-stopped' });
    await dispatcher.tick();
    expect(typed).toEqual([]);
  });

  it('a paste that throws holds the item transport-uncertain', async () => {
    const { dispatcher, enqueue, item } = setup();
    (dispatcher as unknown as { deps: IInboxDispatcherDeps }).deps.deliver = async () => { throw new Error('tmux gone'); };
    enqueue('i-m1');
    await dispatcher.tick();
    expect(item('i-m1').state).toBe('held');
    expect(item('i-m1').heldReason).toMatch(/^transport-uncertain:/);
  });

  it('switch-off-refuses-queued: with tab-send.queue off, the next tick refuses each queued message queue-off and types nothing', async () => {
    const { dispatcher, typed, enqueue, item, world } = setup({ queueOn: false });
    enqueue('i-m1');
    enqueue('i-m2', { targetTabId: 'tab-9', targetSessionName: 'pt-x' });
    await dispatcher.tick();
    expect(typed).toEqual([]);
    expect(item('i-m1')).toMatchObject({ state: 'dropped', droppedReason: 'queue-off' });
    expect(item('i-m2')).toMatchObject({ state: 'dropped', droppedReason: 'queue-off' });
    world.queueOn = true;
    enqueue('i-m3');
    await dispatcher.tick();
    expect(typed).toHaveLength(1);
  });

  it('a message skips the coordinator window', async () => {
    const { world, enqueue, typed } = setup();
    const window = {
      governs: vi.fn(async () => true), openAt: () => T0 + 60_000, inboxTurn: () => false, claim: vi.fn(), setInboxHeads: () => {},
    };
    const dispatcher = new InboxDispatcher({
      ...((setup().dispatcher as unknown as { deps: IInboxDispatcherDeps }).deps),
      mutate: async (fn) => { const { state, value } = fn(world.state); world.state = state; return value; },
      deliver: async (_s, text) => { typed.push(text); },
      window: () => window as never,
    });
    enqueue('i-m1');
    await dispatcher.tick();
    expect(typed).toHaveLength(1);
    expect(window.governs).not.toHaveBeenCalled();
  });
});
