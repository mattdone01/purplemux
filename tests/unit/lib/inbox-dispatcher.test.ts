import { describe, expect, it, vi } from 'vitest';
import { InboxDispatcher, type IInboxDispatcherDeps } from '@/lib/inbox-dispatcher';
import { enqueueInState, INBOX_MAX_REFUSALS } from '@/lib/inbox-store';
import type { IInboxState } from '@/types/inbox';
import type { IClientTabStatusEntry } from '@/types/status';
import type { ITab, TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';

const T0 = Date.parse('2026-09-26T06:00:00.000Z');
const EMPTY_CLAUDE = 'output\n────────\n❯ \n────────\n';
const TYPED_CLAUDE = 'output\n────────\n❯ half a sentence\n────────\n';

interface IWorld {
  clock: number;
  state: IInboxState;
  cliState: TCliState;
  waiting: boolean;
  pane: string | null;
  panelType: TPanelType;
  tabPresent: boolean;
  gone: boolean | null;
  sessionName: string;
  alive: boolean;
  policy: { ok: boolean; error?: string };
  permission: boolean;
  deliverFails: boolean;
  stranded: boolean;
}

const setup = (overrides: Partial<IWorld> = {}) => {
  const world: IWorld = {
    clock: T0, state: { items: [] }, cliState: 'idle', waiting: false, pane: EMPTY_CLAUDE, panelType: 'claude-code',
    tabPresent: true, gone: true, sessionName: 'pt-ws-1-pane-a-tab-w', alive: true, policy: { ok: true }, permission: false, deliverFails: false, stranded: false,
    ...overrides,
  };
  const deliver = vi.fn(async (_session: string, _line: string) => {
    if (world.deliverFails) throw new Error('tmux paste failed');
  });
  const tab = (): ITab => ({ id: 'tab-w', name: 'w', order: 0, sessionName: world.sessionName, panelType: world.panelType });
  const calls: string[] = [];
  const deps: IInboxDispatcherDeps = {
    now: () => world.clock,
    mutate: async (fn) => {
      const { state, value } = fn(world.state);
      world.state = state;
      return value;
    },
    findTab: async () => { calls.push('findTab'); return world.tabPresent ? tab() : null; },
    tabGone: async () => world.gone,
    hasSession: async () => world.alive,
    status: () => ({ cliState: world.cliState, permissionRequest: world.permission ? { id: 'p' } : null } as unknown as IClientTabStatusEntry),
    waitingAtPrompt: () => world.waiting,
    capture: async () => { calls.push('capture'); return world.pane; },
    withDispatchLock: async (_ws, _tab, work) => {
      calls.push('lock:enter');
      try {
        return await work(async () => { calls.push('policy'); return world.policy as never; });
      } finally {
        calls.push('lock:exit');
      }
    },
    deliver: async (session: string, line: string) => { calls.push('deliver'); await deliver(session, line); },
    isPending: async () => world.stranded,
  };
  const dispatcher = new InboxDispatcher(deps);
  const enqueue = (dedupeKey = 'k1', resumeId = 'r-abcd12') => {
    const result = enqueueInState(world.state, {
      kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-w', dedupeKey, fields: { resumeId },
    }, world.clock, () => `i-${dedupeKey}`);
    world.state = result.state;
    return result.item;
  };
  const item = (id = 'i-k1') => world.state.items.find((i) => i.id === id)!;
  return { world, dispatcher, deliver, enqueue, item, calls };
};

const LINE = '[purplemux resume r-abcd12] the last turn ended on an API error — continue from where it was cut off';

describe('inbox dispatcher (ADR-0012)', () => {
  it('delivers the exact rendered line once to an idle agent with an empty composer', async () => {
    const { dispatcher, deliver, enqueue, item } = setup();
    enqueue();
    await dispatcher.tick();
    await dispatcher.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('pt-ws-1-pane-a-tab-w', LINE);
    expect(item()).toMatchObject({ state: 'delivered', deliveredAt: T0 });
  });

  it('types nothing into a mid-turn busy agent, then delivers within one tick of it turning idle', async () => {
    const { world, dispatcher, deliver, enqueue, item } = setup({ cliState: 'busy' });
    enqueue();
    await dispatcher.tick();
    expect(item()).toMatchObject({ state: 'queued', attempts: 1, lastRefusal: 'composer-not-ready:busy', notBefore: T0 + 10_000 });
    world.clock += 2_000;
    await dispatcher.tick();
    expect(deliver).not.toHaveBeenCalled();
    world.cliState = 'idle';
    world.clock += 2_000; // one tick, far inside the 10 s backoff
    await dispatcher.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(item().state).toBe('delivered');
  });

  it('delivers to a WAITING agent (ruling A′-inbox) within one tick of its stop being classified', async () => {
    const { world, dispatcher, deliver, enqueue, item } = setup({ cliState: 'busy', waiting: false });
    enqueue();
    await dispatcher.tick();
    expect(item().lastRefusal).toBe('composer-not-ready:busy');
    world.waiting = true; // the stop was classified WAITING; cliState stays busy
    world.clock += 2_000;
    await dispatcher.tick();
    expect(deliver).toHaveBeenCalledWith('pt-ws-1-pane-a-tab-w', LINE);
    expect(item().state).toBe('delivered');
  });

  it('types nothing into a busy agent that is not waiting at its prompt (e.g. after a relaunch)', async () => {
    const { world, dispatcher, deliver, enqueue, item } = setup({ cliState: 'busy', waiting: false });
    enqueue();
    for (let i = 0; i < 5; i++) {
      world.clock += 300_000;
      await dispatcher.tick();
    }
    expect(deliver).not.toHaveBeenCalled();
    expect(item()).toMatchObject({ state: 'queued', attempts: 5, lastRefusal: 'composer-not-ready:busy' });
  });

  it('types nothing into a composer that holds text, and names the refusal', async () => {
    const { dispatcher, deliver, enqueue, item } = setup({ pane: TYPED_CLAUDE });
    enqueue();
    await dispatcher.tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(item().lastRefusal).toBe('composer-not-empty');
  });

  it('does not early-wake a composer-not-empty refusal: it waits out its backoff', async () => {
    const { world, dispatcher, deliver, enqueue } = setup({ pane: TYPED_CLAUDE });
    enqueue();
    await dispatcher.tick();
    world.pane = EMPTY_CLAUDE;
    world.clock += 2_000;
    await dispatcher.tick();
    expect(deliver).not.toHaveBeenCalled();
    world.clock += 10_000;
    await dispatcher.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a native permission prompt', { permission: true }, 'native-prompt-active'],
    ['an option list on screen', { pane: 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n' }, 'interactive-prompt-active'],
    ['an unreadable pane', { pane: null }, 'composer-unreadable'],
    ['a dead session', { alive: false }, 'session-not-running'],
    ['a model-policy hold', { policy: { ok: false, error: 'agent-model-mismatch' } }, 'policy:agent-model-mismatch'],
  ] as Array<[string, Partial<IWorld>, string]>)('refuses %s', async (_label, overrides, reason) => {
    const { dispatcher, deliver, enqueue, item } = setup(overrides);
    enqueue();
    await dispatcher.tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(item()).toMatchObject({ state: 'queued', lastRefusal: reason });
  });

  it('holds after 30 consecutive refusals, with the last refusal, and stops trying', async () => {
    const { world, dispatcher, deliver, enqueue, item } = setup({ cliState: 'busy' });
    enqueue();
    for (let i = 0; i < INBOX_MAX_REFUSALS; i++) {
      await dispatcher.tick();
      world.clock += 300_000;
    }
    expect(item()).toMatchObject({ state: 'held', attempts: 30, heldReason: 'composer-not-ready:busy (30 refusals)' });
    world.cliState = 'idle';
    await dispatcher.tick();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('holds a paste that throws as transport-uncertain and never retries it', async () => {
    const { dispatcher, deliver, enqueue, item } = setup({ deliverFails: true });
    enqueue();
    await dispatcher.tick();
    await dispatcher.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(item()).toMatchObject({ state: 'held', heldReason: 'transport-uncertain:tmux paste failed' });
  });

  it('holds a line still pending in the composer after the paste as stranded-in-composer', async () => {
    const { dispatcher, deliver, enqueue, item } = setup({ stranded: true });
    enqueue();
    await dispatcher.tick();
    await dispatcher.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(item()).toMatchObject({ state: 'held', heldReason: 'stranded-in-composer' });
  });

  it('refuses, never drops, a missing tab it cannot confirm gone (an unreadable store is not a close)', async () => {
    const { dispatcher, enqueue, item } = setup({ tabPresent: false, gone: null });
    enqueue();
    await dispatcher.tick();
    expect(item()).toMatchObject({ state: 'queued', lastRefusal: 'target-unresolved', attempts: 1 });
  });

  it('checks, re-finds, applies policy, reads the screen and pastes inside the dispatch lock, in that order', async () => {
    const { dispatcher, enqueue, calls } = setup();
    enqueue();
    await dispatcher.tick();
    expect(calls).toEqual(['findTab', 'lock:enter', 'findTab', 'policy', 'capture', 'deliver', 'lock:exit']);
  });

  it('refuses target-changed when the tab was replaced between the first look and the lock', async () => {
    const { world, dispatcher, deliver, enqueue, item } = setup();
    enqueue();
    let looks = 0;
    const original = world.sessionName;
    Object.defineProperty(world, 'sessionName', { get: () => (++looks > 1 ? 'pt-ws-1-pane-a-tab-w2' : original) });
    await dispatcher.tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(item().lastRefusal).toBe('target-changed');
  });

  it('lets shutdown wait for a delivery in flight to be recorded', async () => {
    const { world, dispatcher, deliver, enqueue } = setup();
    let release!: () => void;
    deliver.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    enqueue();
    const tick = dispatcher.tick();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
    let idle = false;
    const waiting = dispatcher.idle().then(() => { idle = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(idle).toBe(false);
    release();
    await Promise.all([tick, waiting]);
    expect(world.state.items[0].state).toBe('delivered');
  });

  it('drops the queue of a tab missing from its layout, and holds a notice for a non-agent tab', async () => {
    const gone = setup({ tabPresent: false });
    gone.enqueue();
    await gone.dispatcher.tick();
    expect(gone.item()).toMatchObject({ state: 'dropped', droppedReason: 'target-tab-closed' });

    const shell = setup({ panelType: 'terminal' });
    shell.enqueue();
    await shell.dispatcher.tick();
    expect(shell.deliver).not.toHaveBeenCalled();
    expect(shell.item()).toMatchObject({ state: 'held', heldReason: 'target-not-agent' });
  });

  it('drops queued and held items when the target tab closes', async () => {
    const { world, dispatcher, enqueue, item } = setup({ deliverFails: true });
    enqueue('k1');
    await dispatcher.tick(); // k1 held
    enqueue('k2', 'r-efgh34');
    const dropped = await dispatcher.dropForTab('ws-1', 'tab-w');
    expect(dropped.map((i) => i.id).sort()).toEqual(['i-k1', 'i-k2']);
    expect(item('i-k1')).toMatchObject({ state: 'dropped', droppedReason: 'target-tab-closed' });
    expect(world.state.items.every((i) => i.state === 'dropped')).toBe(true);
  });

  it('delivers one notice per tab per tick, in order', async () => {
    const { world, dispatcher, deliver, enqueue } = setup();
    enqueue('k1', 'r-first1');
    world.clock += 1;
    enqueue('k2', 'r-second');
    await dispatcher.tick();
    expect(deliver.mock.calls.map(([, line]) => line.split(' ')[2])).toEqual(['r-first1]']);
    await dispatcher.tick();
    expect(deliver.mock.calls.map(([, line]) => line.split(' ')[2])).toEqual(['r-first1]', 'r-second]']);
  });

  it('prunes a terminal item 7 days after its transition on a tick', async () => {
    const { world, dispatcher, enqueue } = setup();
    enqueue();
    await dispatcher.tick();
    world.clock += 7 * 24 * 60 * 60 * 1000;
    await dispatcher.tick();
    expect(world.state.items).toEqual([]);
  });

  it('never runs two ticks at once', async () => {
    const { world, dispatcher, deliver, enqueue } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    deliver.mockImplementationOnce(async () => { await gate; });
    enqueue();
    const first = dispatcher.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await dispatcher.tick();
    release();
    await first;
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(world.state.items[0].state).toBe('delivered');
  });
});
