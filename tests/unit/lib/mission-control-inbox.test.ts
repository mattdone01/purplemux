import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IInboxItem, IInboxState } from '@/types/inbox';
import type { IMissionBinding, IMissionQuestion, TMissionProducerEvent } from '@/types/mission-control';
import type { ITab } from '@/types/terminal';

// Story 12 (consult ruling A′, evidence/reviews/12-consult.out): Mission Control delivers through the
// tab inbox. These run the REAL MissionControlStore on a temp database and the REAL InboxDispatcher
// with fake tmux, including the two tests the ruling names as the ones that would disprove it.

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

import { InboxDispatcher, type IInboxDispatcherDeps } from '@/lib/inbox-dispatcher';
import { enqueueInState, withdrawInState } from '@/lib/inbox-store';
import { MissionControlRuntime, type IMissionRuntimeDeps } from '@/lib/mission-control-runtime';
import { MissionControlStore, type IMissionDiscoveryInput } from '@/lib/mission-control-store';

const scratch: string[] = [];
const runtimes: MissionControlRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const databasePath = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-mission-inbox-'));
  scratch.push(directory);
  return path.join(directory, 'mission.sqlite');
};

const binding: IMissionBinding = { tabId: 'tab-orchestrator', providerId: 'codex', sessionId: 'session-current', generation: 1, runtimeGeneration: 'launch-1' };
const identity = { tabId: binding.tabId, providerId: binding.providerId, sessionId: binding.sessionId, runtimeGeneration: binding.runtimeGeneration };
const question: IMissionQuestion = {
  kind: 'question',
  title: 'Choose a rollout',
  context: 'The migration needs one rollout strategy.',
  storyIds: ['MC-1'],
  options: [{ id: 'gradual', label: 'Gradual' }, { id: 'direct', label: 'Direct' }],
  recommendation: 'gradual',
  blockingScope: 'story',
  canContinue: true,
};

const seedAnswer = (store: MissionControlStore) => {
  const start: TMissionProducerEvent = {
    eventId: 'event-start', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0,
    producerAt: 1_700_000_000_000, bindingGeneration: 0, type: 'run.started',
    payload: { objective: 'Deliver Mission Control', tabId: binding.tabId },
  };
  store.applyEvents([start], new Map([[start.eventId, identity]]));
  const opened: TMissionProducerEvent = {
    eventId: 'event-open', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0,
    producerAt: 1_700_000_000_100, bindingGeneration: 1, type: 'attention.opened',
    payload: {
      itemId: 'item-a', ...question,
      humanReview: { humanNeed: 'decision', humanReason: 'Only the human can choose.', handling: 'Checked.', reviewerTabId: binding.tabId },
    },
  };
  store.applyEvents([opened], new Map([[opened.eventId, { resolvedIdentity: identity, configuredOrchestratorTabId: binding.tabId }]]));
  return store.submitAnswer('item-a', { submissionId: 'submission-a', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false }, 'user');
};

/** The server's two loops over one in-memory inbox, with a fake pane for every tab. */
const world = (file: string) => {
  let inbox: IInboxState = { items: [] };
  let clock = Date.now();
  let seq = 0;
  let crashAfterPaste = false;
  let pasted = false;
  const identities = new Map<string, Omit<IMissionBinding, 'generation'>>([[binding.tabId, identity]]);
  const busy = new Set<string>();
  const deliver = vi.fn(async (_session: string, _line: string) => {
    pasted = true;
  });
  const mutate = async <T>(fn: (state: IInboxState) => { state: IInboxState; value: T }): Promise<T> => {
    // A crash right after a paste: the write that would record it never happens.
    if (crashAfterPaste && pasted) throw new Error('process died after the paste');
    const result = fn(inbox);
    inbox = result.state;
    return result.value;
  };
  const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `pt-${id}`, panelType: 'claude-code' });
  const dispatcherDeps: IInboxDispatcherDeps = {
    now: () => clock,
    mutate,
    findTab: async (_workspaceId, tabId) => tab(tabId),
    tabGone: async () => false,
    hasSession: async () => true,
    status: (tabId) => ({ cliState: busy.has(tabId) ? 'busy' : 'idle', permissionRequest: null }) as never,
    waitingAtPrompt: () => false,
    halted: () => false,
    capture: async () => 'done\n❯ ',
    withDispatchLock: (_workspaceId, target, work) => work(async () => ({ ok: true as const })),
    deliver,
    isPending: async () => false,
  };
  const runtime = (store: MissionControlStore): MissionControlRuntime => {
    const deps: IMissionRuntimeDeps = {
      getStore: () => store,
      now: () => Math.max(clock, Date.now()),
      discover: vi.fn(),
      workspaceViews: async () => [],
      resolveIdentity: async (_workspaceId, tabId) => identities.get(tabId) ?? null,
      inbox: {
        enqueue: (request) => mutate((state) => {
          const result = enqueueInState(state, request, clock, () => `i-test${(seq += 1)}`);
          return { state: result.state, value: { item: result.item, created: result.created } };
        }),
        items: async () => inbox.items,
        withdraw: (id, reason) => mutate((state) => {
          const next = withdrawInState(state, id, reason, clock);
          return { state: next, value: next !== state };
        }),
        registerPreflight: (kind, fn) => {
          // The real registry: the dispatcher reads it.
          return registerReal(kind, fn);
        },
      },
      setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
      clearInterval: vi.fn(),
    };
    const created = new MissionControlRuntime(deps);
    runtimes.push(created);
    return created;
  };
  return {
    file,
    items: (): IInboxItem[] => inbox.items,
    deliver,
    identities,
    busy,
    dispatcher: () => new InboxDispatcher(dispatcherDeps),
    runtime,
    advance: (ms: number) => { clock += ms; },
    crashAfterNextPaste: () => { crashAfterPaste = true; pasted = false; },
    recover: () => { crashAfterPaste = false; },
  };
};

import { registerInboxPreflight as registerReal } from '@/lib/inbox-dispatcher';

describe('Mission Control through the inbox (story 12, ruling A′)', () => {
  it('a crash between the paste and its record never types the answer twice (the ruling\'s disproving test)', async () => {
    const w = world(databasePath());
    const store1 = new MissionControlStore(w.file);
    const accepted = seedAnswer(store1);
    const runtime1 = w.runtime(store1);
    await runtime1.tick();
    expect(w.items()).toHaveLength(1);
    expect(store1.snapshot().deliveries[0]).toMatchObject({ state: 'queued', nextAttemptAt: null, lastError: `inbox:${w.items()[0].id}` });

    w.crashAfterNextPaste();
    await expect(w.dispatcher().tick()).rejects.toThrow('process died after the paste');
    expect(w.deliver).toHaveBeenCalledOnce();
    expect(w.items()[0].state).toBe('queued'); // the delivered write was lost
    await runtime1.stop(); // the process is gone: its preflight with it
    store1.close();
    w.recover();

    // A fresh process on the same database and inbox. The inbox ticks before Mission Control starts.
    const store2 = new MissionControlStore(w.file);
    const dispatcher2 = w.dispatcher();
    await dispatcher2.tick();
    expect(w.items()[0]).toMatchObject({ state: 'queued', lastRefusal: 'preflight-unregistered' });
    const runtime2 = w.runtime(store2);
    await runtime2.tick();
    w.advance(60_000);
    await dispatcher2.tick();

    expect(w.deliver).toHaveBeenCalledOnce();
    expect(store2.snapshot().deliveries.find((row) => row.id === accepted.delivery.id))
      .toMatchObject({ state: 'held', lastError: 'server-restarted-during-uncertain-delivery' });
    expect(w.items()[0].state).toBe('dropped');
    store2.close();
  });

  it('an answer waiting in the inbox moves with run.resumed and is typed once (the companion test)', async () => {
    const w = world(databasePath());
    const store = new MissionControlStore(w.file);
    const accepted = seedAnswer(store);
    const runtime = w.runtime(store);
    await runtime.tick();
    const itemId = w.items()[0].id;

    const replacement = { ...identity, sessionId: 'session-replacement' };
    const resume: TMissionProducerEvent = {
      eventId: 'event-resume', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 1,
      producerAt: 1_700_000_000_300, bindingGeneration: 1, type: 'run.resumed',
      payload: { tabId: binding.tabId, transferPendingAnswers: true },
    };
    store.applyEvents([resume], new Map([[resume.eventId, replacement]]));
    expect(store.snapshot().deliveries[0]).toMatchObject({ state: 'queued', lastError: null });
    w.identities.set(binding.tabId, replacement);

    await runtime.tick();
    expect(store.snapshot().deliveries[0]).toMatchObject({ state: 'queued', lastError: `inbox:${itemId}` });
    await w.dispatcher().tick();
    await runtime.tick();

    expect(w.deliver).toHaveBeenCalledOnce();
    expect(w.items()).toHaveLength(1);
    expect(w.items()[0].state).toBe('delivered');
    const row = store.snapshot().deliveries.find((candidate) => candidate.id === accepted.delivery.id)!;
    expect(row).toMatchObject({ state: 'submitted', lastError: null, submittedAt: w.items()[0].deliveredAt });
    expect(row.binding?.sessionId).toBe('session-replacement');
    store.close();
  });

  it('an orchestrator busy for 24 h leaves the answer held with the readiness reason, and nothing typed', async () => {
    const w = world(databasePath());
    const store = new MissionControlStore(w.file);
    seedAnswer(store);
    const runtime = w.runtime(store);
    await runtime.tick();
    w.busy.add(binding.tabId);
    const dispatcher = w.dispatcher();

    await dispatcher.tick();
    expect(w.items()[0].lastRefusal).toMatch(/busy/);
    w.advance(24 * 60 * 60 * 1000 + 1);
    await dispatcher.tick();
    await runtime.tick();

    expect(w.deliver).not.toHaveBeenCalled();
    expect(w.items()[0].state).toBe('held');
    const row = store.snapshot().deliveries[0];
    expect(row.state).toBe('held');
    expect(row.lastError).toMatch(/busy.*undelivered after 24 h/);
    store.close();
  });

  it('a cancelled answer never reaches the tab: the waiting notice is withdrawn', async () => {
    const w = world(databasePath());
    const store = new MissionControlStore(w.file);
    seedAnswer(store);
    const runtime = w.runtime(store);
    await runtime.tick();
    const cancel: TMissionProducerEvent = {
      eventId: 'event-cancel', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 2,
      producerAt: 1_700_000_000_300, bindingGeneration: 1, type: 'attention.cancelled',
      payload: { itemId: 'item-a', reason: 'No longer needed' },
    };
    store.applyEvents([cancel]);

    await runtime.tick();
    await w.dispatcher().tick();

    expect(w.deliver).not.toHaveBeenCalled();
    expect(w.items()[0]).toMatchObject({ state: 'dropped', droppedReason: 'mission-record-not-waiting' });
    store.close();
  });

  it('a reconcile bootstrap with three live orchestrators queues three one-line notices, each typed once', async () => {
    const w = world(databasePath());
    const store = new MissionControlStore(w.file);
    const workspace = (id: string, tabId: string) => {
      const tabBinding = { ...identity, tabId, sessionId: `session-${id}` };
      w.identities.set(tabId, tabBinding);
      return {
        workspaceId: `ws-${id}`, name: id, activity: 'active' as const, agents: [], lastActivityAt: 1_700_000_000_000,
        lastProgressAt: 1_700_000_000_000, stale: false, identities: [tabBinding],
        evidence: { source: 'harness' as const, sourceId: `${id}/workspace`, observedAt: 1_700_000_000_000, confidence: 'confirmed' as const },
        run: {
          sourceKey: `${id}/run`, objective: `Objective ${id}`, phase: 'implementation', state: 'running' as const, nextStep: 'Continue',
          lastProgressAt: 1_700_000_000_000,
          evidence: { source: 'bootstrap' as const, sourceId: `${id}/evidence`, observedAt: 1_700_000_000_000, confidence: 'provisional' as const },
        },
        candidates: [],
        reconciliation: { sourceKey: `${id}/reconcile`, binding: { ...tabBinding, generation: 1 } },
      };
    };
    const input: IMissionDiscoveryInput = {
      bootstrapId: 'bootstrap-three', reconcile: true, boundarySeq: 0, observedAt: 1_700_000_000_000,
      workspaces: [workspace('one', 'tab-one'), workspace('two', 'tab-two'), workspace('three', 'tab-three')],
    };
    const bootstrap = store.reconcileDiscovery(input);
    expect(bootstrap.entries.map((entry) => entry.state)).toEqual(['queued', 'queued', 'queued']);
    const runtime = w.runtime(store);

    await runtime.tick();
    expect(w.items()).toHaveLength(3);
    for (const item of w.items()) {
      expect(item.line).not.toContain('\n');
      expect(item.line).toMatch(/^\[purplemux mission boot-[0-9a-f]{32}\] Mission Control asks this orchestrator to reconcile — read: purplemux mission bootstrap -w ws-(one|two|three)$/);
    }
    await w.dispatcher().tick();
    await runtime.tick();
    await w.dispatcher().tick();

    expect(w.deliver).toHaveBeenCalledTimes(3);
    expect(new Set(w.deliver.mock.calls.map(([session]) => session))).toEqual(new Set(['pt-tab-one', 'pt-tab-two', 'pt-tab-three']));
    expect(store.snapshot().bootstrap?.entries.map((entry) => entry.state)).toEqual(['submitted', 'submitted', 'submitted']);
    store.close();
  });
});
