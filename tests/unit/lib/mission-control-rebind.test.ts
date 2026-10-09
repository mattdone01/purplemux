import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IMissionBinding, IMissionQuestion, TMissionProducerEvent } from '@/types/mission-control';

// The REAL MissionControlStore on a temp database under the REAL runtime, with the harness
// observations (live identity, configured orchestrator, layout) supplied by the test.

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

import { MissionControlRuntime, type IMissionOrchestratorTarget, type IMissionRuntimeDeps } from '@/lib/mission-control-runtime';
import { MissionControlStore } from '@/lib/mission-control-store';

type TIdentity = Omit<IMissionBinding, 'generation'>;

const scratch: string[] = [];
const stores: MissionControlStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const START = 1_800_000_000_000;
const RETRY_MS = 5_000;
const incumbent: TIdentity = { tabId: 'tab-old', providerId: 'claude', sessionId: 'session-old', runtimeGeneration: null };
const successor: TIdentity = { tabId: 'tab-next', providerId: 'claude', sessionId: 'session-next', runtimeGeneration: null };
const question: IMissionQuestion = {
  kind: 'question',
  title: 'Choose a rollout',
  context: 'The cutover needs one rollout strategy.',
  storyIds: [],
  options: [{ id: 'gradual', label: 'Gradual' }],
  recommendation: 'gradual',
  blockingScope: 'story',
  canContinue: true,
};

const startRun = (store: MissionControlStore, workspaceId = 'ws-a', runId = 'run-a', identity: TIdentity = incumbent): void => {
  const start: TMissionProducerEvent = {
    eventId: `event-start-${runId}`, schemaVersion: 1, workspaceId, runId, expectedRevision: 0,
    producerAt: START, bindingGeneration: 0, type: 'run.started',
    payload: { objective: 'Safeguard the production cutover', tabId: identity.tabId },
  };
  store.applyEvents([start], new Map([[start.eventId, identity]]));
};

const world = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-mission-rebind-'));
  scratch.push(directory);
  const store = new MissionControlStore(path.join(directory, 'mission.sqlite'));
  stores.push(store);
  let clock = START;
  const identities = new Map<string, TIdentity>();
  const targets = new Map<string, IMissionOrchestratorTarget>();
  const resolveIdentity = vi.fn(async (_workspaceId: string, tabId: string) => identities.get(tabId) ?? null);
  const orchestratorTarget = vi.fn(async (workspaceId: string) => targets.get(workspaceId) ?? null);
  const deps: IMissionRuntimeDeps = {
    getStore: () => store,
    now: () => clock,
    discover: vi.fn(),
    workspaceViews: async () => [],
    resolveIdentity,
    orchestratorTarget,
    withMappingRead: (_workspaceId, work) => work(),
    inbox: {
      enqueue: vi.fn(async () => { throw new Error('no notice is expected'); }),
      items: async () => [],
      withdraw: async () => true,
      registerPreflight: () => () => {},
    },
    setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
    clearInterval: vi.fn(),
  };
  return {
    store,
    runtime: new MissionControlRuntime(deps),
    identities,
    targets,
    resolveIdentity,
    orchestratorTarget,
    advance: (ms: number) => { clock += ms; },
    run: (runId = 'run-a') => store.snapshot().runs.find((candidate) => candidate.id === runId)!,
    rebounds: () => store.eventsAfter(0, 200).events.filter((event) => event.type === 'run.rebound'),
  };
};

describe('Mission Control follows an orchestrator change', () => {
  it.each(['handoff', 'recover', 'replace'] as const)('a %s rebinds the open run to the new orchestrator at the next generation, audited', async (cause) => {
    const w = world();
    startRun(w.store);
    w.identities.set(successor.tabId, successor);
    const before = w.run();

    const events = await w.runtime.rebindToOrchestrator('ws-a', successor.tabId, cause);

    expect(w.run().binding).toEqual({ ...successor, generation: 2 });
    expect(w.run().revision).toBe(before.revision + 1);
    expect(events).toHaveLength(1);
    expect(w.rebounds()).toEqual(events);
    expect(events[0]).toMatchObject({
      type: 'run.rebound', runId: 'run-a', revision: before.revision + 1,
      payload: { cause, previousBinding: { ...incumbent, generation: 1 }, binding: { ...successor, generation: 2 } },
    });
  });

  it('after a handoff the old generation is refused and the new orchestrator may escalate to the human', async () => {
    const w = world();
    startRun(w.store);
    w.identities.set(successor.tabId, successor);
    await w.runtime.rebindToOrchestrator('ws-a', successor.tabId, 'handoff');

    const stale: TMissionProducerEvent = {
      eventId: 'event-old-progress', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 2,
      producerAt: START + 1, bindingGeneration: 1, type: 'progress.updated', payload: { phase: 'cutover' },
    };
    expect(() => w.store.applyEvents([stale])).toThrowError('stale or unbound orchestrator generation');
    const escalate: TMissionProducerEvent = {
      eventId: 'event-escalate', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0,
      producerAt: START + 2, bindingGeneration: 2, type: 'attention.opened',
      payload: {
        itemId: 'item-a', ...question,
        humanReview: { humanNeed: 'approval', humanReason: 'Only the owner approves the cutover.', handling: 'Checked the runbook.', reviewerTabId: successor.tabId },
      },
    };
    w.store.applyEvents([escalate], new Map([[escalate.eventId, { resolvedIdentity: successor, configuredOrchestratorTabId: successor.tabId }]]));
    expect(w.store.snapshot().items[0]).toMatchObject({ state: 'open', humanReview: { binding: { ...successor, generation: 2 } } });
  });

  it('a repeated handoff to the same tab does not bump the generation again', async () => {
    const w = world();
    startRun(w.store);
    w.identities.set(successor.tabId, successor);
    await w.runtime.rebindToOrchestrator('ws-a', successor.tabId, 'handoff');
    const settled = w.run();

    expect(await w.runtime.rebindToOrchestrator('ws-a', successor.tabId, 'handoff')).toEqual([]);
    expect(await w.runtime.rebindToOrchestrator('ws-a', successor.tabId, 'recover')).toEqual([]);

    expect(w.run()).toEqual(settled);
    expect(w.rebounds()).toHaveLength(1);
  });

  it('writes no binding while the new identity is unresolved, and rebinds with the original cause once it resolves', async () => {
    const w = world();
    startRun(w.store);
    w.targets.set('ws-a', { tabId: successor.tabId, tabIds: [incumbent.tabId, successor.tabId] });
    const before = w.run();

    expect(await w.runtime.rebindToOrchestrator('ws-a', successor.tabId, 'handoff')).toEqual([]);
    await w.runtime.tick();
    expect(w.run()).toEqual(before);
    expect(w.rebounds()).toEqual([]);

    w.identities.set(successor.tabId, successor);
    const attempts = w.resolveIdentity.mock.calls.length;
    await w.runtime.tick();
    expect(w.resolveIdentity).toHaveBeenCalledTimes(attempts);
    expect(w.run()).toEqual(before);

    w.advance(RETRY_MS);
    await w.runtime.tick();
    expect(w.run().binding).toEqual({ ...successor, generation: 2 });
    expect(w.rebounds().map((event) => event.payload.cause)).toEqual(['handoff']);

    w.advance(RETRY_MS);
    const settledAttempts = w.resolveIdentity.mock.calls.length;
    await w.runtime.tick();
    expect(w.resolveIdentity).toHaveBeenCalledTimes(settledAttempts);
    expect(w.rebounds()).toHaveLength(1);
  });

  it('a pending rebind follows the orchestrator committed last, and stops when none is configured', async () => {
    const w = world();
    startRun(w.store);
    startRun(w.store, 'ws-b', 'run-b');
    await w.runtime.rebindToOrchestrator('ws-a', successor.tabId, 'handoff');
    await w.runtime.rebindToOrchestrator('ws-b', successor.tabId, 'recover');
    const third: TIdentity = { ...successor, tabId: 'tab-third', sessionId: 'session-third' };
    w.targets.set('ws-a', { tabId: third.tabId, tabIds: [third.tabId] });
    w.identities.set(successor.tabId, successor);
    w.identities.set(third.tabId, third);

    await w.runtime.tick();

    expect(w.run().binding).toEqual({ ...third, generation: 2 });
    expect(w.run('run-b').binding).toEqual({ ...incumbent, generation: 1 });
    w.targets.set('ws-b', { tabId: successor.tabId, tabIds: [successor.tabId] });
    w.advance(RETRY_MS);
    await w.runtime.tick();
    expect(w.run('run-b').binding).toEqual({ ...incumbent, generation: 1 });
  });

  it('never fails the committed change: a storage failure leaves the rebind pending for the worker', async () => {
    const w = world();
    startRun(w.store);
    w.identities.set(successor.tabId, successor);
    w.targets.set('ws-a', { tabId: successor.tabId, tabIds: [successor.tabId] });
    const failing = vi.spyOn(w.store, 'rebindOpenRuns').mockImplementationOnce(() => { throw new Error('database is locked'); });

    await expect(w.runtime.rebindToOrchestrator('ws-a', successor.tabId, 'recover')).resolves.toEqual([]);
    expect(w.run().binding).toEqual({ ...incumbent, generation: 1 });

    await w.runtime.tick();
    expect(failing).toHaveBeenCalledTimes(2);
    expect(w.run().binding).toEqual({ ...successor, generation: 2 });
    expect(w.rebounds().map((event) => event.payload.cause)).toEqual(['recover']);
  });

  it('keeps nothing pending for a workspace with no open bound run', async () => {
    const w = world();
    w.targets.set('ws-a', { tabId: successor.tabId, tabIds: [successor.tabId] });

    expect(await w.runtime.rebindToOrchestrator('ws-a', successor.tabId, 'handoff')).toEqual([]);
    await w.runtime.tick();

    expect(w.resolveIdentity).not.toHaveBeenCalled();
    expect(w.orchestratorTarget).not.toHaveBeenCalled();
  });
});

describe('Mission Control heals bindings left on a closed tab (server start)', () => {
  it('rebinds a run whose bound tab is gone to the live configured orchestrator, with cause heal', async () => {
    const w = world();
    startRun(w.store);
    w.targets.set('ws-a', { tabId: successor.tabId, tabIds: [successor.tabId, 'tab-worker'] });
    w.identities.set(successor.tabId, successor);

    await w.runtime.tick();

    expect(w.run().binding).toEqual({ ...successor, generation: 2 });
    expect(w.rebounds()).toHaveLength(1);
    expect(w.rebounds()[0]).toMatchObject({
      runId: 'run-a', revision: 2,
      payload: { cause: 'heal', previousBinding: { ...incumbent, generation: 1 }, binding: { ...successor, generation: 2 } },
    });
  });

  it('leaves a run bound to the live configured orchestrator untouched', async () => {
    const w = world();
    startRun(w.store);
    w.targets.set('ws-a', { tabId: incumbent.tabId, tabIds: [incumbent.tabId, successor.tabId] });
    w.identities.set(incumbent.tabId, incumbent);
    const before = w.run();

    await w.runtime.tick();

    expect(w.run()).toEqual(before);
    expect(w.rebounds()).toEqual([]);
    expect(w.resolveIdentity).not.toHaveBeenCalled();
  });

  it('leaves a run alone while its bound tab is still in the workspace, even when another tab is the orchestrator', async () => {
    const w = world();
    startRun(w.store);
    w.targets.set('ws-a', { tabId: successor.tabId, tabIds: [incumbent.tabId, successor.tabId] });
    w.identities.set(successor.tabId, successor);
    const before = w.run();

    await w.runtime.tick();

    expect(w.run()).toEqual(before);
    expect(w.rebounds()).toEqual([]);
  });

  it('leaves the run alone while the orchestrator identity does not resolve, and heals when it does', async () => {
    const w = world();
    startRun(w.store);
    w.targets.set('ws-a', { tabId: successor.tabId, tabIds: [successor.tabId] });
    const before = w.run();

    await w.runtime.tick();
    expect(w.resolveIdentity).toHaveBeenCalledWith('ws-a', successor.tabId);
    expect(w.run()).toEqual(before);
    expect(w.rebounds()).toEqual([]);

    w.identities.set(successor.tabId, successor);
    w.advance(RETRY_MS);
    await w.runtime.tick();
    expect(w.run().binding).toEqual({ ...successor, generation: 2 });
    expect(w.rebounds().map((event) => event.payload.cause)).toEqual(['heal']);
  });

  it('leaves the run alone without a configured orchestrator in a readable layout', async () => {
    const w = world();
    startRun(w.store);
    w.identities.set(successor.tabId, successor);
    const before = w.run();

    await w.runtime.tick();
    w.targets.set('ws-a', { tabId: successor.tabId, tabIds: [successor.tabId] });
    w.advance(RETRY_MS);
    await w.runtime.tick();

    expect(w.run()).toEqual(before);
    expect(w.rebounds()).toEqual([]);
    expect(w.orchestratorTarget).toHaveBeenCalledTimes(1);
  });

  it('heals only stale workspaces and skips finished runs', async () => {
    const w = world();
    startRun(w.store);
    startRun(w.store, 'ws-b', 'run-b');
    startRun(w.store, 'ws-c', 'run-c');
    w.store.applyEvents([{
      eventId: 'event-finish-c', schemaVersion: 1, workspaceId: 'ws-c', runId: 'run-c', expectedRevision: 1,
      producerAt: START + 1, bindingGeneration: 1, type: 'run.finished', payload: { state: 'completed', summary: 'Done', closeoutPending: false },
    }]);
    for (const workspaceId of ['ws-a', 'ws-c']) w.targets.set(workspaceId, { tabId: successor.tabId, tabIds: [successor.tabId] });
    w.targets.set('ws-b', { tabId: incumbent.tabId, tabIds: [incumbent.tabId] });
    w.identities.set(successor.tabId, successor);
    const finished = w.run('run-c');
    const live = w.run('run-b');

    await w.runtime.tick();

    expect(w.rebounds().map((event) => event.runId)).toEqual(['run-a']);
    expect(w.run('run-b')).toEqual(live);
    expect(w.run('run-c')).toEqual(finished);
    expect(w.orchestratorTarget.mock.calls.map(([workspaceId]) => workspaceId).sort()).toEqual(['ws-a', 'ws-b']);
  });

  it('scans once per process and is idempotent across passes', async () => {
    const w = world();
    startRun(w.store);
    w.targets.set('ws-a', { tabId: successor.tabId, tabIds: [successor.tabId] });
    w.identities.set(successor.tabId, successor);
    const scan = vi.spyOn(w.store, 'listOpenRunBindings');

    await w.runtime.tick();
    const scans = scan.mock.calls.filter((call) => call.length === 0 || call[0] === undefined).length;
    w.advance(RETRY_MS);
    await w.runtime.tick();
    w.advance(RETRY_MS);
    await w.runtime.tick();

    expect(scans).toBe(1);
    expect(scan.mock.calls.filter((call) => call.length === 0 || call[0] === undefined)).toHaveLength(1);
    expect(w.rebounds()).toHaveLength(1);
    expect(w.run().binding?.generation).toBe(2);
  });

  it('a failing heal never stops the delivery pass', async () => {
    const w = world();
    startRun(w.store);
    w.orchestratorTarget.mockRejectedValue(new Error('workspaces.json unreadable'));
    const due = vi.spyOn(w.store, 'listDueDeliveries');

    await expect(w.runtime.tick()).resolves.toBeUndefined();

    expect(due).toHaveBeenCalled();
    expect(w.rebounds()).toEqual([]);
  });
});
