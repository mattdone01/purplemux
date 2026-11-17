import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxDispatcher, registerInboxPreflight, type IInboxDispatcherDeps } from '@/lib/inbox-dispatcher';
import { enqueueInState } from '@/lib/inbox-store';
import { MissionControlRuntime, type IMissionControlRuntimeStore, type IMissionRuntimeDeps, type TMissionTargetObservation } from '@/lib/mission-control-runtime';
import type { IInboxState } from '@/types/inbox';
import type { IMissionBinding, IMissionDelivery } from '@/types/mission-control';
import type { IClientTabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// ADR-0049 §6, case 1 and case 2, end to end at the inbox dispatcher with a fake remote host (review r1: the CONFIRM's
// CONCERN and Sonnet 2). The real dispatcher and the real Mission Control preflight run; the remote host is a fake:
// its proof (`observeTarget`), its paste (`deliver`) and its composer read (`isPending`). The owner's answer to a remote
// coordinator is typed once when the host answers; a host that cannot tell leaves it queued and retried, never dropped.

const T0 = Date.parse('2026-11-17T06:00:00.000Z');
const ANSWER = `answer-${'a'.repeat(32)}`;
const EMPTY_CLAUDE = 'output\n────────\n❯ \n────────\n';
const binding: IMissionBinding = { tabId: 'tab-c', providerId: 'claude', sessionId: 'session-c', generation: 2, runtimeGeneration: null };
const identity = { tabId: 'tab-c', providerId: 'claude', sessionId: 'session-c', runtimeGeneration: null };

type THost = 'answers' | 'cannot-tell' | 'agent-gone';

const setup = () => {
  const world = {
    clock: T0,
    inbox: { items: [] } as IInboxState,
    host: 'answers' as THost,
    /** The paste over ssh: the host drops after the proof, so the send's outcome is unknown. */
    pasteThrows: false,
    /** The composer read over ssh after the paste fails. */
    captureFails: false,
    row: null as IMissionDelivery | null,
  };
  const typed: string[] = [];
  const tab = (): ITab => ({ id: 'tab-c', name: 'lead', order: 0, sessionName: 'pt-ws-a-pane-a-tab-c', panelType: 'claude-code', host: 'host-a' });

  const store = {
    listInboxHandoffs: vi.fn(() => ({ deliveries: world.row ? [world.row] : [], bootstrapEntries: [] })),
    claimInboxDelivery: vi.fn((id: string, marker: string) => {
      if (!world.row || world.row.id !== id || world.row.state !== 'queued' || world.row.lastError !== marker) return null;
      world.row = { ...world.row, state: 'dispatching', updatedAt: world.row.updatedAt + 1 };
      return world.row;
    }),
    validateDeliveryAttempt: vi.fn(() => ({ ok: true as const })),
    finalizeDeliveryAttempt: vi.fn(),
  } as unknown as IMissionControlRuntimeStore;

  const observeTarget = vi.fn(async (): Promise<TMissionTargetObservation> => {
    if (world.host === 'cannot-tell') return { state: 'unknown', reason: 'remote host host-a did not answer (timeout)' };
    if (world.host === 'agent-gone') return { state: 'not-live' };
    return { state: 'live', identity };
  });
  const runtimeDeps = {
    getStore: () => store,
    now: () => world.clock,
    resolveIdentity: vi.fn(async () => { throw new Error('the preflight reads observeTarget'); }),
    observeTarget,
  } as unknown as IMissionRuntimeDeps;
  const runtime = new MissionControlRuntime(runtimeDeps);

  const deps: IInboxDispatcherDeps = {
    now: () => world.clock,
    mutate: async (fn) => {
      const { state, value } = fn(world.inbox);
      world.inbox = state;
      return value;
    },
    findTab: async () => tab(),
    tabGone: async () => false,
    // The host answers has-session in every case here: the doubt is the proof's (the CONFIRM's realistic path).
    hasSession: async () => true,
    status: () => ({ cliState: 'idle', permissionRequest: null, turnEnd: null } as unknown as IClientTabStatusEntry),
    waitingAtPrompt: () => false,
    halted: () => false,
    capture: async () => EMPTY_CLAUDE,
    withDispatchLock: async (_ws, _tab, work) => work(async () => ({ ok: true }) as never),
    deliver: async (_session: string, line: string) => {
      typed.push(line);
      if (world.pasteThrows) throw new Error('ssh: connection reset');
    },
    isPending: async () => {
      if (world.captureFails) throw new Error('ssh: capture timed out');
      return false;
    },
  };
  const dispatcher = new InboxDispatcher(deps);

  const enqueue = () => {
    const result = enqueueInState(world.inbox, {
      kind: 'mission', targetWorkspaceId: 'ws-a', targetTabId: 'tab-c', dedupeKey: 'mission:delivery:delivery-one',
      fields: { answerId: ANSWER, workspaceId: 'ws-a', readyAt: T0 },
    }, world.clock, () => 'i-one');
    world.inbox = result.state;
    world.row = {
      id: 'delivery-one', answerId: ANSWER, workspaceId: 'ws-a', runId: 'run-one', binding, state: 'queued', attempts: 1,
      nextAttemptAt: null, lastError: 'inbox:i-one', submittedAt: null, acknowledgedAt: null, updatedAt: 2,
    };
  };
  const item = () => world.inbox.items.find((i) => i.id === 'i-one')!;
  const unregister = registerInboxPreflight('mission', (i) => runtime.preflight(i));
  return { world, dispatcher, enqueue, item, typed, observeTarget, unregister };
};

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

describe('an owner answer to a remote coordinator, through the inbox (ADR-0049 §6)', () => {
  it('a host that cannot tell at paste time keeps the answer queued and retried; it is typed once when the host answers', async () => {
    const t = setup();
    cleanup = t.unregister;
    t.enqueue();
    t.world.host = 'cannot-tell';
    await t.dispatcher.tick();
    expect(t.item()).toMatchObject({ state: 'queued', attempts: 1, lastRefusal: expect.stringContaining('preflight:bound-agent-unknown') });
    expect(t.world.row).toMatchObject({ state: 'queued' });
    expect(t.typed).toEqual([]);

    // Inside its backoff the item is not tried again; after it, still cannot tell: refused again, still queued.
    await t.dispatcher.tick();
    expect(t.observeTarget).toHaveBeenCalledTimes(1);
    t.world.clock += 10_001;
    await t.dispatcher.tick();
    expect(t.item()).toMatchObject({ state: 'queued', attempts: 2 });
    expect(t.typed).toEqual([]);

    t.world.host = 'answers';
    t.world.clock += 30_001;
    await t.dispatcher.tick();
    expect(t.item()).toMatchObject({ state: 'delivered' });
    expect(t.world.row).toMatchObject({ state: 'dispatching' });
    t.world.clock += 300_001;
    await t.dispatcher.tick();
    await t.dispatcher.tick();
    expect(t.typed).toHaveLength(1);
    expect(t.typed[0]).toContain(`[purplemux mission ${ANSWER}]`);
  });

  it('an agent the host positively reports gone is not live, as before: the item is dropped and nothing is typed', async () => {
    const t = setup();
    cleanup = t.unregister;
    t.enqueue();
    t.world.host = 'agent-gone';
    await t.dispatcher.tick();
    expect(t.item()).toMatchObject({ state: 'dropped', droppedReason: 'preflight:bound-agent-not-live' });
    expect(t.typed).toEqual([]);
  });

  it('a paste that throws over ssh is held transport-uncertain and never typed again', async () => {
    const t = setup();
    cleanup = t.unregister;
    t.enqueue();
    t.world.pasteThrows = true;
    await t.dispatcher.tick();
    expect(t.item()).toMatchObject({ state: 'held', heldReason: expect.stringContaining('transport-uncertain') });
    t.world.pasteThrows = false;
    for (let i = 0; i < 3; i += 1) {
      t.world.clock += 300_001;
      await t.dispatcher.tick();
    }
    expect(t.typed).toHaveLength(1);
  });

  it('a composer read that fails over ssh after the paste reads delivered, not stranded, and is not typed again', async () => {
    const t = setup();
    cleanup = t.unregister;
    t.enqueue();
    t.world.captureFails = true;
    await t.dispatcher.tick();
    expect(t.item()).toMatchObject({ state: 'delivered' });
    t.world.clock += 300_001;
    await t.dispatcher.tick();
    expect(t.typed).toHaveLength(1);
  });
});
