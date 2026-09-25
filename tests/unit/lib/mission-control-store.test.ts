import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionControlError } from '@/lib/mission-control-errors';
import { MissionControlStore, type IMissionDiscoveryInput } from '@/lib/mission-control-store';
import type { IMissionBinding, IMissionQuestion, TMissionProducerEvent } from '@/types/mission-control';

const scratch: string[] = [];
const binding: IMissionBinding = {
  tabId: 'tab-orchestrator',
  providerId: 'codex',
  sessionId: 'session-current',
  generation: 1,
  runtimeGeneration: 'launch-1',
};
const identity = { ...binding, generation: undefined };
delete identity.generation;
const observedIdentity = (name: string) => ({
  tabId: `tab-${name}`,
  providerId: 'codex',
  sessionId: `session-${name}`,
  runtimeGeneration: `launch-${name}`,
});

const question: IMissionQuestion = {
  kind: 'question',
  title: 'Choose a rollout',
  context: 'The migration needs one rollout strategy.',
  storyIds: ['MC-1'],
  options: [
    { id: 'gradual', label: 'Gradual' },
    { id: 'direct', label: 'Direct' },
  ],
  recommendation: 'gradual',
  blockingScope: 'story',
  canContinue: true,
};

const databasePath = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-mission-'));
  scratch.push(directory);
  return path.join(directory, 'mission.sqlite');
};

const startEvent = (eventId = 'event-start'): TMissionProducerEvent => ({
  eventId,
  schemaVersion: 1,
  workspaceId: 'ws-a',
  runId: 'run-a',
  expectedRevision: 0,
  producerAt: 1_700_000_000_000,
  bindingGeneration: 0,
  type: 'run.started',
  payload: { objective: 'Deliver Mission Control', tabId: binding.tabId },
});

const openEvent = (eventId = 'event-open'): TMissionProducerEvent => ({
  eventId,
  schemaVersion: 1,
  workspaceId: 'ws-a',
  runId: 'run-a',
  expectedRevision: 0,
  producerAt: 1_700_000_000_100,
  bindingGeneration: 1,
  type: 'attention.opened',
  payload: { itemId: 'item-a', ...question },
});

const seed = (store: MissionControlStore): void => {
  const start = startEvent();
  store.applyEvents([start], new Map([[start.eventId, identity]]));
  store.applyEvents([openEvent()]);
};

const discoveryInput = (
  bootstrapId: string,
  sourceKey = `${bootstrapId}/run`,
  workspaceId = 'ws-a',
): IMissionDiscoveryInput => ({
  bootstrapId,
  reconcile: true,
  boundarySeq: 0,
  observedAt: 1_700_000_000_000,
  workspaces: [{
    workspaceId,
    name: workspaceId,
    activity: 'active',
    agents: [],
    lastActivityAt: 1_700_000_000_000,
    lastProgressAt: 1_700_000_000_000,
    stale: false,
    identities: [identity],
    evidence: { source: 'harness', sourceId: `${sourceKey}/workspace`, observedAt: 1_700_000_000_000, confidence: 'confirmed' },
    run: {
      sourceKey,
      objective: `Objective for ${workspaceId}`,
      phase: 'implementation',
      state: 'running',
      nextStep: 'Continue',
      lastProgressAt: 1_700_000_000_000,
      evidence: { source: 'bootstrap', sourceId: `${sourceKey}/evidence`, observedAt: 1_700_000_000_000, confidence: 'provisional' },
    },
    candidates: [],
    reconciliation: { sourceKey: `${sourceKey}/reconcile`, binding },
  }],
});

afterEach(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('MissionControlStore', () => {
  it('persists open attention and replays events after reopen without cursor gaps', () => {
    const file = databasePath();
    const first = new MissionControlStore(file);
    seed(first);
    first.close();

    const reopened = new MissionControlStore(file);
    const snapshot = reopened.snapshot();
    expect(snapshot.items).toMatchObject([{ id: 'item-a', state: 'open', revision: 1 }]);
    expect(snapshot.cursor).toBe(2);
    const page = reopened.eventsAfter(0, 1);
    expect(page.events).toHaveLength(1);
    expect(page.cursor).toBe(page.events[0].seq);
    expect(page.hasMore).toBe(true);
    expect(reopened.eventsAfter(page.cursor, 10).events).toHaveLength(1);
    reopened.close();
  });

  it('migrates schema v2 identity metadata transactionally without losing durable runs', () => {
    const file = databasePath();
    const original = new MissionControlStore(file);
    seed(original);
    original.close();

    const legacy = new Database(file);
    legacy.exec('ALTER TABLE runs DROP COLUMN observed_identities_json');
    legacy.pragma('user_version = 2');
    legacy.close();

    const migrated = new MissionControlStore(file);
    expect(migrated.snapshot().runs).toMatchObject([{ id: 'run-a', objective: 'Deliver Mission Control' }]);
    migrated.close();
    const inspected = new Database(file, { readonly: true });
    expect(inspected.pragma('user_version', { simple: true })).toBe(3);
    expect((inspected.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((column) => column.name))
      .toContain('observed_identities_json');
    inspected.close();
  });

  it('returns original answer results for identical retries and conflicts on changed reuse', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const request = {
      submissionId: 'submission-a',
      expectedRevision: 1,
      optionIds: ['gradual'],
      text: '',
      actionCompleted: false,
    };
    const created = store.submitAnswer('item-a', request, 'user');
    const replay = store.submitAnswer('item-a', request, 'user');
    expect(created.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.answer.id).toBe(created.answer.id);
    expect(replay.delivery.id).toBe(created.delivery.id);
    expect(() => store.submitAnswer('item-a', { ...request, text: 'different' }, 'user'))
      .toThrowError(MissionControlError);
    expect(store.snapshot().answers).toHaveLength(1);
    store.close();
  });

  it('rolls back an entire producer batch when a later event conflicts', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const progress: TMissionProducerEvent = {
      eventId: 'event-progress', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_200, bindingGeneration: 1,
      type: 'progress.updated', payload: { phase: 'testing' },
    };
    const stale: TMissionProducerEvent = {
      eventId: 'event-stale', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 99, producerAt: 1_700_000_000_300, bindingGeneration: 1,
      type: 'attention.updated', payload: { itemId: 'item-a', ...question, title: 'Changed' },
    };
    expect(() => store.applyEvents([progress, stale])).toThrowError(MissionControlError);
    const snapshot = store.snapshot();
    expect(snapshot.runs[0]).toMatchObject({ revision: 1, phase: null });
    expect(snapshot.recentEvents.map((event) => event.id)).not.toContain('event-progress');
    store.close();
  });

  it('rejects cross-workspace references and stale orchestrator generations', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const crossWorkspace: TMissionProducerEvent = {
      eventId: 'event-cross', schemaVersion: 1, workspaceId: 'ws-b', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_200, bindingGeneration: 1,
      type: 'progress.updated', payload: { phase: 'wrong' },
    };
    const staleGeneration: TMissionProducerEvent = {
      ...crossWorkspace,
      eventId: 'event-old-generation',
      workspaceId: 'ws-a',
      bindingGeneration: 0,
    };
    expect(() => store.applyEvents([crossWorkspace])).toThrowError(/another workspace/);
    expect(() => store.applyEvents([staleGeneration])).toThrowError(/generation/);
    store.close();
  });

  it('does not expose another workspace row through colliding opaque IDs', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const collidingRun = { ...startEvent('event-cross-run'), workspaceId: 'ws-b' };
    try {
      store.applyEvents([collidingRun], new Map([[collidingRun.eventId, identity]]));
      throw new Error('expected run collision');
    } catch (error) {
      expect(error).toBeInstanceOf(MissionControlError);
      expect((error as MissionControlError).current).toBeUndefined();
    }

    const secondStart = { ...startEvent('event-start-b'), workspaceId: 'ws-b', runId: 'run-b' };
    store.applyEvents([secondStart], new Map([[secondStart.eventId, identity]]));
    const collidingItem = { ...openEvent('event-cross-item'), workspaceId: 'ws-b', runId: 'run-b' };
    try {
      store.applyEvents([collidingItem]);
      throw new Error('expected item collision');
    } catch (error) {
      expect(error).toBeInstanceOf(MissionControlError);
      expect((error as MissionControlError).current).toBeUndefined();
    }
    store.close();
  });

  it('requires acknowledgement before resolution and survives delivery recovery', () => {
    const file = databasePath();
    const store = new MissionControlStore(file);
    seed(store);
    const accepted = store.submitAnswer('item-a', {
      submissionId: 'submission-a', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false,
    }, 'user');
    const claimed = store.claimDelivery(accepted.delivery.id, accepted.delivery.updatedAt);
    expect(claimed?.state).toBe('dispatching');
    store.close();

    const reopened = new MissionControlStore(file);
    expect(reopened.recoverDispatching('uncertain after restart')).toBe(1);
    expect(reopened.snapshot().deliveries[0]).toMatchObject({ state: 'held', lastError: 'uncertain after restart' });
    const resolve: TMissionProducerEvent = {
      eventId: 'event-resolve', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 2, producerAt: 1_700_000_000_300, bindingGeneration: 1,
      type: 'attention.resolved', payload: { itemId: 'item-a', resolution: 'Applied' },
    };
    expect(() => reopened.applyEvents([resolve])).toThrowError(/acknowledged/);
    const acknowledge: TMissionProducerEvent = {
      eventId: 'event-ack', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 2, producerAt: 1_700_000_000_250, bindingGeneration: 1,
      type: 'answer.acknowledged', payload: { answerId: accepted.answer.id },
    };
    reopened.applyEvents([acknowledge, resolve]);
    const replay = reopened.applyEvents([acknowledge]);
    expect(replay.replayed).toBe(true);
    expect(replay.events[0].id).toBe('event-ack');
    expect(reopened.snapshot().items[0].state).toBe('resolved');
    reopened.close();
  });

  it('rechecks delivery eligibility around paste and preserves uncertainty across resume', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const accepted = store.submitAnswer('item-a', {
      submissionId: 'submission-race', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false,
    }, 'user');
    const claimed = store.claimDelivery(accepted.delivery.id, accepted.delivery.updatedAt);
    expect(claimed).not.toBeNull();
    expect(store.validateDeliveryAttempt(claimed!.id, claimed!.updatedAt, binding)).toEqual({ ok: true });

    const resume: TMissionProducerEvent = {
      eventId: 'event-resume-race', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_300, bindingGeneration: 1,
      type: 'run.resumed', payload: { tabId: binding.tabId, transferPendingAnswers: true },
    };
    store.applyEvents([resume], new Map([[resume.eventId, identity]]));
    expect(store.validateDeliveryAttempt(claimed!.id, claimed!.updatedAt, binding))
      .toEqual({ ok: false, reason: 'delivery-not-dispatching' });
    const finalized = store.finalizeDeliveryAttempt(claimed!.id, claimed!.updatedAt, binding, {
      state: 'submitted', nextAttemptAt: null, lastError: null, submittedAt: Date.now(),
    });
    expect(finalized).toMatchObject({
      state: 'held',
      lastError: 'transport-uncertain:post-paste-eligibility-changed:delivery-not-dispatching',
    });
    expect(finalized!.updatedAt).toBeGreaterThan(claimed!.updatedAt);
    store.close();
  });

  it('does not requeue an answer after its attention item is cancelled', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const accepted = store.submitAnswer('item-a', {
      submissionId: 'submission-cancel', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false,
    }, 'user');
    const cancel: TMissionProducerEvent = {
      eventId: 'event-cancel-answer', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 2, producerAt: 1_700_000_000_300, bindingGeneration: 1,
      type: 'attention.cancelled', payload: { itemId: 'item-a', reason: 'No longer needed' },
    };
    store.applyEvents([cancel]);
    const resume: TMissionProducerEvent = {
      eventId: 'event-resume-cancelled', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_400, bindingGeneration: 1,
      type: 'run.resumed', payload: { tabId: binding.tabId, transferPendingAnswers: true },
    };
    store.applyEvents([resume], new Map([[resume.eventId, identity]]));
    expect(store.snapshot().deliveries.find((delivery) => delivery.id === accepted.delivery.id))
      .toMatchObject({ state: 'held', lastError: 'attention item cancelled' });
    expect(store.listDueDeliveries(Date.now() + 10_000, 10)).toEqual([]);
    store.close();
  });

  it('merges live workspace observations with durable state and retains missing workspaces as orphans', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const secondOpen: TMissionProducerEvent = {
      eventId: 'event-open-second', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 0, producerAt: 1_700_000_000_150, bindingGeneration: 1,
      type: 'attention.opened',
      payload: { itemId: 'item-second', ...question, title: 'Second question' },
    };
    store.applyEvents([secondOpen]);
    const accepted = store.submitAnswer('item-a', {
      submissionId: 'submission-snapshot', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false,
    }, 'user');
    store.reconcileDiscovery({
      ...discoveryInput('bootstrap-snapshot'),
      workspaces: [
        discoveryInput('bootstrap-snapshot').workspaces[0],
        discoveryInput('bootstrap-orphan', 'orphan/run', 'ws-orphan').workspaces[0],
      ],
    });
    const liveView = {
      ...store.snapshot().workspaces.find((view) => view.workspaceId === 'ws-a')!,
      runIds: [], openItems: 0, awaitingAcknowledgement: 0, lastProgressAt: null,
      evidence: { source: 'harness' as const, sourceId: 'live-ws-a', observedAt: 1_700_000_001_000, confidence: 'confirmed' as const },
    };
    const merged = store.snapshot([liveView]);
    expect(merged.workspaces.find((view) => view.workspaceId === 'ws-a')).toMatchObject({
      runIds: ['run-a'], openItems: 1, awaitingAcknowledgement: 1,
      lastProgressAt: 1_700_000_000_000,
    });
    expect(merged.runs.find((run) => run.id === 'run-a')?.objective).toBe('Deliver Mission Control');
    expect(merged.workspaces.find((view) => view.workspaceId === 'ws-orphan')).toMatchObject({
      orphaned: true, runIds: [expect.any(String)],
    });

    store.applyEvents([{
      eventId: 'event-ack-snapshot', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 2, producerAt: accepted.answer.createdAt, bindingGeneration: 1,
      type: 'answer.acknowledged', payload: { answerId: accepted.answer.id },
    }]);
    expect(store.snapshot([liveView]).workspaces.find((view) => view.workspaceId === 'ws-a')?.awaitingAcknowledgement)
      .toBe(0);
    store.close();
  });

  it('does not recreate a stale observed run after a terminal event crossed the bootstrap boundary', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    store.applyEvents([{
      eventId: 'event-finished-after-boundary', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_300, bindingGeneration: 1,
      type: 'run.finished', payload: { state: 'completed', summary: 'Done', closeoutPending: false },
    }]);
    const stale = discoveryInput('bootstrap-after-finish', 'ws-a/stale-run');
    stale.boundarySeq = 2;
    const result = store.reconcileDiscovery(stale);
    expect(result.entries).toEqual([]);
    expect(store.snapshot().runs).toMatchObject([{ id: 'run-a', state: 'completed' }]);
    store.close();
  });

  it.each(['queued', 'dispatching', 'submitted', 'held'] as const)(
    'confirms a %s bootstrap entry monotonically and rejects late completion',
    (state) => {
      const store = new MissionControlStore(databasePath());
      const bootstrapId = `bootstrap-confirm-${state}`;
      store.reconcileDiscovery(discoveryInput(bootstrapId));
      const pending = store.listQueuedBootstrapEntries(1)[0];
      let staleUpdatedAt = pending.entry.updatedAt;
      if (state !== 'queued') {
        const claimed = store.claimBootstrapEntry(bootstrapId, 'ws-a', pending.entry.runId, pending.entry.updatedAt)!;
        staleUpdatedAt = claimed.entry.updatedAt;
        expect(store.validateBootstrapAttempt(bootstrapId, 'ws-a', pending.entry.runId, claimed.entry.updatedAt))
          .toEqual({ ok: true });
        if (state === 'submitted' || state === 'held') {
          const completed = store.completeBootstrapAttempt(bootstrapId, 'ws-a', pending.entry.runId, claimed.entry.updatedAt, {
            state, reason: state === 'held' ? 'uncertain' : null,
          })!;
          staleUpdatedAt = completed.updatedAt;
        }
      }
      const runId = pending.entry.runId;
      const resume: TMissionProducerEvent = {
        eventId: `event-confirm-${state}`, schemaVersion: 1, workspaceId: 'ws-a', runId,
        expectedRevision: 0, producerAt: 1_700_000_000_500, bindingGeneration: 0,
        type: 'run.resumed', payload: { tabId: binding.tabId, transferPendingAnswers: false },
      };
      store.applyEvents([resume], new Map([[resume.eventId, identity]]));
      const confirmed = store.snapshot().bootstrap!.entries[0];
      expect(confirmed.state).toBe('confirmed');
      expect(confirmed.updatedAt).toBeGreaterThan(staleUpdatedAt);
      expect(store.validateBootstrapAttempt(bootstrapId, 'ws-a', runId, staleUpdatedAt).ok).toBe(false);
      expect(store.completeBootstrapAttempt(bootstrapId, 'ws-a', runId, staleUpdatedAt, {
        state: 'submitted', reason: null,
      })).toBeNull();
      expect(store.snapshot().bootstrap!.entries[0].state).toBe('confirmed');
      store.close();
    },
  );

  it.each(['queued', 'dispatching', 'submitted', 'held'] as const)(
    'run.started confirms a %s bootstrap entry and invalidates its dispatch CAS',
    (state) => {
      const store = new MissionControlStore(databasePath());
      const bootstrapId = `bootstrap-start-${state}`;
      store.reconcileDiscovery(discoveryInput(bootstrapId));
      const pending = store.listQueuedBootstrapEntries(1)[0];
      let staleUpdatedAt = pending.entry.updatedAt;
      if (state !== 'queued') {
        const claimed = store.claimBootstrapEntry(bootstrapId, 'ws-a', pending.entry.runId, pending.entry.updatedAt)!;
        staleUpdatedAt = claimed.entry.updatedAt;
        expect(store.validateBootstrapAttempt(bootstrapId, 'ws-a', pending.entry.runId, staleUpdatedAt))
          .toEqual({ ok: true });
        if (state === 'submitted' || state === 'held') {
          const completed = store.completeBootstrapAttempt(bootstrapId, 'ws-a', pending.entry.runId, staleUpdatedAt, {
            state, reason: state === 'held' ? 'uncertain' : null,
          })!;
          staleUpdatedAt = completed.updatedAt;
        }
      }
      const start = { ...startEvent(`event-start-${state}`), runId: pending.entry.runId };
      store.applyEvents([start], new Map([[start.eventId, identity]]));
      const confirmed = store.snapshot().bootstrap!.entries[0];
      expect(confirmed.state).toBe('confirmed');
      expect(confirmed.updatedAt).toBeGreaterThan(staleUpdatedAt);
      expect(store.validateBootstrapAttempt(bootstrapId, 'ws-a', pending.entry.runId, staleUpdatedAt))
        .toEqual({ ok: false, reason: 'bootstrap-entry-not-dispatching' });
      expect(store.completeBootstrapAttempt(bootstrapId, 'ws-a', pending.entry.runId, staleUpdatedAt, {
        state: 'submitted', reason: null,
      })).toBeNull();
      store.close();
    },
  );

  it('rejects bootstrap dispatch when another confirmed run becomes current', () => {
    const store = new MissionControlStore(databasePath());
    store.reconcileDiscovery(discoveryInput('bootstrap-current-check'));
    const pending = store.listQueuedBootstrapEntries(1)[0];
    const claimed = store.claimBootstrapEntry(
      pending.bootstrapId, pending.entry.workspaceId, pending.entry.runId, pending.entry.updatedAt,
    )!;
    const concurrentStart = { ...startEvent('event-concurrent-start'), runId: 'run-concurrent' };
    store.applyEvents([concurrentStart], new Map([[concurrentStart.eventId, identity]]));
    expect(store.validateBootstrapAttempt(
      pending.bootstrapId, pending.entry.workspaceId, pending.entry.runId, claimed.entry.updatedAt,
    )).toEqual({ ok: false, reason: 'bootstrap-run-not-current' });
    store.close();
  });

  it('creates a fresh provisional for a new lifecycle while tombstoning a completed source', () => {
    const store = new MissionControlStore(databasePath());
    store.reconcileDiscovery(discoveryInput('bootstrap-lifecycle-a', 'orchestrator/session-a'));
    const lifecycleA = store.snapshot().runs[0];
    const start = { ...startEvent('event-lifecycle-a-start'), runId: lifecycleA.id };
    store.applyEvents([start], new Map([[start.eventId, identity]]));
    store.applyEvents([{
      eventId: 'event-lifecycle-a-finish', schemaVersion: 1, workspaceId: 'ws-a', runId: lifecycleA.id,
      expectedRevision: 1, producerAt: 1_700_000_000_500, bindingGeneration: 1,
      type: 'run.finished', payload: { state: 'completed', summary: 'Done', closeoutPending: false },
    }]);
    const boundary = store.snapshot().cursor;

    const lifecycleBInput = discoveryInput('bootstrap-lifecycle-b', 'orchestrator/session-b');
    lifecycleBInput.boundarySeq = boundary;
    lifecycleBInput.workspaces[0].identities = [observedIdentity('b')];
    expect(store.reconcileDiscovery(lifecycleBInput).entries[0].state).toBe('queued');
    const lifecycleB = store.snapshot().runs.find((run) => run.evidence.confidence === 'provisional');
    expect(lifecycleB).toMatchObject({ revision: 0, state: 'running', binding: null });
    expect(lifecycleB?.id).not.toBe(lifecycleA.id);

    const repeatedA = discoveryInput('bootstrap-lifecycle-a-again', 'orchestrator/session-a');
    repeatedA.boundarySeq = boundary;
    expect(store.reconcileDiscovery(repeatedA).entries).toMatchObject([{
      state: 'provisional', reason: 'reconciliation already recorded', runId: lifecycleB?.id,
    }]);
    expect(store.snapshot().runs.filter((run) => run.id === lifecycleA.id)).toHaveLength(1);
    store.close();
  });

  it.each(['completed', 'cancelled'] as const)(
    'uses durable identity membership to suppress %s lifecycle subsets and admit a new identity',
    (terminalState) => {
      const store = new MissionControlStore(databasePath());
      const orchestrator = observedIdentity('orchestrator');
      const workerOne = observedIdentity('worker-one');
      const workerTwo = observedIdentity('worker-two');
      const initial = discoveryInput(`bootstrap-membership-${terminalState}`, 'live-set:o,w1');
      initial.workspaces[0].identities = [workerOne, orchestrator, orchestrator];
      initial.workspaces[0].reconciliation!.sourceKey = 'orchestrator:o';
      store.reconcileDiscovery(initial);
      const firstRunId = store.snapshot().runs[0].id;
      const start = { ...startEvent(`event-membership-start-${terminalState}`), runId: firstRunId };
      store.applyEvents([start], new Map([[start.eventId, identity]]));
      store.applyEvents([{
        eventId: `event-membership-finish-${terminalState}`, schemaVersion: 1,
        workspaceId: 'ws-a', runId: firstRunId, expectedRevision: 1,
        producerAt: 1_700_000_000_600, bindingGeneration: 1,
        type: 'run.finished', payload: { state: terminalState, summary: 'Closed', closeoutPending: false },
      }]);
      const boundary = store.snapshot().cursor;

      const subsets = [
        { source: 'live-set:o,w1', identities: [orchestrator, workerOne] },
        { source: 'live-set:o', identities: [orchestrator] },
        { source: 'live-set:w1', identities: [workerOne] },
        { source: 'live-set:empty', identities: [] },
      ];
      for (const [index, subset] of subsets.entries()) {
        const replay = discoveryInput(`bootstrap-subset-${terminalState}-${index}`, subset.source);
        replay.boundarySeq = boundary;
        replay.workspaces[0].identities = subset.identities;
        replay.workspaces[0].reconciliation!.sourceKey = 'orchestrator:o';
        expect(store.reconcileDiscovery(replay).entries).toEqual([]);
        expect(store.snapshot().runs).toHaveLength(1);
      }
      for (const [index, identities] of [[], [orchestrator]].entries()) {
        const recentStandup = discoveryInput(
          `bootstrap-standup-subset-${terminalState}-${index}`,
          `standup:changed-after-${terminalState}:${index}`,
        );
        recentStandup.boundarySeq = boundary;
        recentStandup.workspaces[0].identities = identities;
        recentStandup.workspaces[0].run!.evidence = {
          source: 'standup', sourceId: `recent-standup-${terminalState}-${index}`,
          observedAt: 1_700_000_000_900 + index, confidence: 'provisional',
        };
        recentStandup.workspaces[0].reconciliation!.sourceKey = 'orchestrator:o';
        expect(store.reconcileDiscovery(recentStandup).entries).toEqual([]);
        expect(store.snapshot().runs).toHaveLength(1);
      }

      const changed = discoveryInput(`bootstrap-new-worker-${terminalState}`, 'live-set:o,w2');
      changed.boundarySeq = boundary;
      changed.workspaces[0].identities = [orchestrator, workerTwo];
      changed.workspaces[0].reconciliation!.sourceKey = 'orchestrator:o';
      expect(store.reconcileDiscovery(changed).entries).toMatchObject([{
        state: 'provisional', reason: 'reconciliation already recorded',
      }]);
      expect(store.snapshot().runs).toHaveLength(2);
      expect(store.snapshot().runs.find((run) => run.revision === 0)).toMatchObject({ binding: null });
      store.close();
    },
  );

  it('accumulates identities on the current run and suppresses recombined historical sets after close', () => {
    const store = new MissionControlStore(databasePath());
    const orchestrator = observedIdentity('orchestrator');
    const workerOne = observedIdentity('worker-one');
    const workerTwo = observedIdentity('worker-two');
    const initial = discoveryInput('bootstrap-identity-union-a', 'live-set:o,w1');
    initial.workspaces[0].identities = [orchestrator, workerOne];
    store.reconcileDiscovery(initial);
    const runId = store.snapshot().runs[0].id;

    const expanded = discoveryInput('bootstrap-identity-union-expanded', 'live-set:o,w1,w2');
    expanded.workspaces[0].identities = [workerTwo, orchestrator, workerOne];
    store.reconcileDiscovery(expanded);
    const start = { ...startEvent('event-identity-union-start'), runId };
    store.applyEvents([start], new Map([[start.eventId, identity]]));
    store.applyEvents([{
      eventId: 'event-identity-union-finish', schemaVersion: 1, workspaceId: 'ws-a', runId,
      expectedRevision: 1, producerAt: 1_700_000_000_700, bindingGeneration: 1,
      type: 'run.finished', payload: { state: 'completed', summary: 'Closed', closeoutPending: false },
    }]);
    const afterFinish = store.snapshot().cursor;

    const recombined = discoveryInput('bootstrap-identity-union-recombined', 'live-set:o,w2');
    recombined.boundarySeq = afterFinish;
    recombined.workspaces[0].identities = [orchestrator, workerTwo];
    expect(store.reconcileDiscovery(recombined).entries).toEqual([]);
    expect(store.snapshot().runs).toHaveLength(1);
    store.close();
  });

  it('treats legacy terminal membership as unknown and seeds one identifiable lifecycle', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    store.applyEvents([{
      eventId: 'event-legacy-finish', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_800, bindingGeneration: 1,
      type: 'run.finished', payload: { state: 'completed', summary: 'Legacy done', closeoutPending: false },
    }]);
    const fresh = discoveryInput('bootstrap-after-legacy', 'live-set:new-session');
    fresh.boundarySeq = store.snapshot().cursor;
    fresh.workspaces[0].identities = [observedIdentity('new-session')];
    expect(store.reconcileDiscovery(fresh).entries[0].state).toBe('queued');
    expect(store.snapshot().runs).toHaveLength(2);
    expect(store.reconcileDiscovery({ ...fresh, bootstrapId: 'bootstrap-after-legacy-repeat' }).entries[0])
      .toMatchObject({ state: 'provisional', reason: 'reconciliation already recorded' });
    expect(store.snapshot().runs).toHaveLength(2);
    store.close();
  });

  it('deduplicates bootstrap sources across IDs and preserves newer semantic state', () => {
    const store = new MissionControlStore(databasePath());
    const discovery = (bootstrapId: string): IMissionDiscoveryInput => ({
      bootstrapId,
      reconcile: true,
      boundarySeq: 0,
      observedAt: 1_700_000_000_000,
      workspaces: [{
        workspaceId: 'ws-a', name: 'Alpha', activity: 'active', agents: [],
        lastActivityAt: 1_700_000_000_000, lastProgressAt: 1_700_000_000_000, stale: false,
        identities: [identity],
        evidence: { source: 'harness', sourceId: 'workspace-a', observedAt: 1_700_000_000_000, confidence: 'confirmed' },
        run: {
          sourceKey: 'ws-a/session-a', objective: 'Observed objective', phase: 'implementation', state: 'running',
          nextStep: 'Continue', lastProgressAt: 1_700_000_000_000,
          evidence: { source: 'bootstrap', sourceId: 'run-source', observedAt: 1_700_000_000_000, confidence: 'provisional' },
        },
        candidates: [{
          sourceKey: 'ws-a/question-a', question,
          evidence: { source: 'bootstrap', sourceId: 'candidate-a', observedAt: 1_700_000_000_000, confidence: 'provisional' },
        }],
        reconciliation: { sourceKey: 'ws-a/reconcile-a', binding },
      }],
    });
    const first = store.reconcileDiscovery(discovery('bootstrap-a'));
    expect(first.entries[0].state).toBe('queued');
    expect(store.snapshot().runs[0]).toMatchObject({ revision: 0, binding: null });
    expect(store.reconcileDiscovery({
      ...discovery('bootstrap-a'),
      observedAt: 1_700_000_000_999,
      workspaces: [],
    })).toEqual(first);

    const provisionalRunId = store.snapshot().runs[0].id;
    const start = { ...startEvent('event-confirm'), runId: provisionalRunId };
    store.applyEvents([start], new Map([[start.eventId, identity]]));
    const second = store.reconcileDiscovery(discovery('bootstrap-b'));
    const snapshot = store.snapshot();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({ revision: 1, objective: 'Deliver Mission Control' });
    expect(snapshot.items).toHaveLength(1);
    expect(second.entries).toEqual([]);
    store.close();
  });

  it('requires a server-resolved resume before a provisional run can report progress or questions', () => {
    const store = new MissionControlStore(databasePath());
    const input: IMissionDiscoveryInput = {
      bootstrapId: 'bootstrap-provisional', reconcile: false, boundarySeq: 0, observedAt: 1_700_000_000_000,
      workspaces: [{
        workspaceId: 'ws-a', name: 'Alpha', activity: 'active', agents: [],
        lastActivityAt: 1_700_000_000_000, lastProgressAt: null, stale: false,
        identities: [identity],
        evidence: { source: 'harness', sourceId: 'workspace-a', observedAt: 1_700_000_000_000, confidence: 'confirmed' },
        run: {
          sourceKey: 'ws-a/provisional', objective: 'Observed', phase: null, state: 'running', nextStep: null,
          lastProgressAt: null,
          evidence: { source: 'bootstrap', sourceId: 'run-provisional', observedAt: 1_700_000_000_000, confidence: 'provisional' },
        }, candidates: [], reconciliation: null,
      }],
    };
    store.reconcileDiscovery(input);
    const runId = store.snapshot().runs[0].id;
    const progress: TMissionProducerEvent = {
      eventId: 'event-provisional-progress', schemaVersion: 1, workspaceId: 'ws-a', runId,
      expectedRevision: 0, producerAt: 1_700_000_000_100, bindingGeneration: 0,
      type: 'progress.updated', payload: { phase: 'unsafe' },
    };
    expect(() => store.applyEvents([progress])).toThrowError(/unbound/);
    const resume: TMissionProducerEvent = {
      eventId: 'event-provisional-resume', schemaVersion: 1, workspaceId: 'ws-a', runId,
      expectedRevision: 0, producerAt: 1_700_000_000_200, bindingGeneration: 0,
      type: 'run.resumed', payload: { tabId: binding.tabId, transferPendingAnswers: false },
    };
    store.applyEvents([resume], new Map([[resume.eventId, identity]]));
    expect(store.snapshot().runs[0]).toMatchObject({ revision: 1, binding: { generation: 1 } });
    store.close();
  });

  it('holds an uncertain bootstrap dispatch after restart instead of sending it twice', () => {
    const store = new MissionControlStore(databasePath());
    const input: IMissionDiscoveryInput = {
      bootstrapId: 'bootstrap-restart', reconcile: true, boundarySeq: 0, observedAt: 1_700_000_000_000,
      workspaces: [{
        workspaceId: 'ws-a', name: 'Alpha', activity: 'active', agents: [],
        lastActivityAt: 1_700_000_000_000, lastProgressAt: 1_700_000_000_000, stale: false,
        identities: [identity],
        evidence: { source: 'harness', sourceId: 'workspace-a', observedAt: 1_700_000_000_000, confidence: 'confirmed' },
        run: {
          sourceKey: 'ws-a/restart-run', objective: 'Observed', phase: null, state: 'running', nextStep: null,
          lastProgressAt: 1_700_000_000_000,
          evidence: { source: 'bootstrap', sourceId: 'restart-run', observedAt: 1_700_000_000_000, confidence: 'provisional' },
        },
        candidates: [],
        reconciliation: { sourceKey: 'ws-a/restart-reconcile', binding },
      }],
    };
    store.reconcileDiscovery(input);
    const pending = store.listQueuedBootstrapEntries(1)[0];
    const claimed = store.claimBootstrapEntry(pending.bootstrapId, pending.entry.workspaceId, pending.entry.runId, pending.entry.updatedAt);
    expect(claimed?.entry.state).toBe('dispatching');
    expect(store.recoverDispatching('uncertain after restart')).toBe(1);
    expect(store.listQueuedBootstrapEntries(1)).toEqual([]);
    expect(store.snapshot().bootstrap?.entries[0]).toMatchObject({ state: 'held', reason: 'uncertain after restart' });
    store.close();
  });

  it('does not queue a second reconciliation for the same source while the first is pending or uncertain', () => {
    const store = new MissionControlStore(databasePath());
    const discovery = (bootstrapId: string, sourceKey = 'ws-a/reconcile-once'): IMissionDiscoveryInput => ({
      bootstrapId, reconcile: true, boundarySeq: 0, observedAt: 1_700_000_000_000,
      workspaces: [{
        workspaceId: 'ws-a', name: 'Alpha', activity: 'active', agents: [],
        lastActivityAt: 1_700_000_000_000, lastProgressAt: null, stale: false,
        identities: [identity],
        evidence: { source: 'harness', sourceId: 'workspace-a', observedAt: 1_700_000_000_000, confidence: 'confirmed' },
        run: {
          sourceKey: 'ws-a/one-run', objective: 'Observed', phase: null, state: 'running', nextStep: null,
          lastProgressAt: null,
          evidence: { source: 'bootstrap', sourceId: 'one-run', observedAt: 1_700_000_000_000, confidence: 'provisional' },
        }, candidates: [], reconciliation: { sourceKey, binding },
      }],
    });
    store.reconcileDiscovery(discovery('bootstrap-one'));
    const pending = store.listQueuedBootstrapEntries(1)[0];
    store.claimBootstrapEntry(pending.bootstrapId, pending.entry.workspaceId, pending.entry.runId, pending.entry.updatedAt);
    expect(store.reconcileDiscovery(discovery('bootstrap-two')).entries[0])
      .toMatchObject({ state: 'provisional', reason: 'reconciliation already recorded' });
    store.recoverDispatching('uncertain');
    expect(store.reconcileDiscovery(discovery('bootstrap-three')).entries[0])
      .toMatchObject({ state: 'provisional', reason: 'reconciliation already recorded' });
    expect(store.listQueuedBootstrapEntries(10)).toHaveLength(0);
    expect(store.reconcileDiscovery(discovery('bootstrap-four', 'ws-a/reconcile-new-identity')).entries[0].state)
      .toBe('queued');
    store.close();
  });
});
