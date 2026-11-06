import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionControlStore, WORKSPACE_DELETED_REASON } from '@/lib/mission-control-store';
import { parseMissionEventBatch, WORKSPACE_DELETED_EVENT_PREFIX } from '@/lib/mission-control-validation';
import type { IMissionBinding, IMissionQuestion, TMissionProducerEvent } from '@/types/mission-control';

// Story 57 (D35): a scratch workspace's runs are test-only. The owner's views (the snapshot's default, the events feed,
// the board's and the pulse's reads) never serve them; internal reads and the explicit includeTest read still do. A
// workspace delete cancels its open and candidate items.

const scratchDirs: string[] = [];
const binding: IMissionBinding = { tabId: 'tab-orch', providerId: 'claude', sessionId: 'session-1', generation: 1, runtimeGeneration: 'launch-1' };
const identity = { tabId: binding.tabId, providerId: binding.providerId, sessionId: binding.sessionId, runtimeGeneration: binding.runtimeGeneration };
const reviewAuthority = { resolvedIdentity: identity, configuredOrchestratorTabId: binding.tabId };
const question: IMissionQuestion = {
  kind: 'question', title: 'Pick one', context: 'Fixture.', storyIds: [],
  options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], recommendation: 'a', blockingScope: 'none', canContinue: true,
};
const humanReview = { humanNeed: 'decision' as const, humanReason: 'Only the owner picks.', handling: 'Checked.', reviewerTabId: binding.tabId };

const databasePath = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-mission-test-runs-'));
  scratchDirs.push(directory);
  return path.join(directory, 'mission.sqlite');
};

const start = (workspaceId: string, runId: string, test?: boolean): TMissionProducerEvent => ({
  eventId: `${runId}-start`, schemaVersion: 1, workspaceId, runId, expectedRevision: 0, producerAt: 1_700_000_000_000, bindingGeneration: 0,
  type: 'run.started', payload: { objective: `run ${runId}`, tabId: binding.tabId, ...(test === undefined ? {} : { test }) },
});

const open = (workspaceId: string, runId: string, itemId: string, options: { review?: boolean; test?: boolean } = {}): TMissionProducerEvent => ({
  eventId: `${itemId}-open`, schemaVersion: 1, workspaceId, runId, expectedRevision: 0, producerAt: 1_700_000_000_100, bindingGeneration: 1,
  type: 'attention.opened',
  payload: { itemId, ...question, ...(options.review === false ? {} : { humanReview }), ...(options.test === undefined ? {} : { test: options.test }) },
});

/** One live run (ws-live) and one scratch run (ws-scratch), each with one item open for the owner. */
const seed = (store: MissionControlStore): void => {
  for (const [workspaceId, runId, itemId, testWorkspace] of [
    ['ws-live', 'run-live', 'item-live', false], ['ws-scratch', 'run-test', 'item-test', true],
  ] as const) {
    const started = start(workspaceId, runId, testWorkspace ? true : undefined);
    store.applyEvents([started], new Map([[started.eventId, identity]]), { testWorkspace });
    const opened = open(workspaceId, runId, itemId, { test: testWorkspace ? true : undefined });
    store.applyEvents([opened], new Map([[opened.eventId, reviewAuthority]]), { testWorkspace });
  }
};

afterEach(() => {
  for (const directory of scratchDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('test-only runs (story 57)', () => {
  it('records every run of a scratch workspace as test-only, and no other run', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    // A scratch run that never declared the flag is test-only too: the workspace decides, the payload only declares.
    const undeclared = start('ws-scratch', 'run-undeclared');
    store.applyEvents([undeclared], new Map([[undeclared.eventId, identity]]), { testWorkspace: true });

    expect(store.isTestRun('run-test')).toBe(true);
    expect(store.isTestRun('run-undeclared')).toBe(true);
    expect(store.isTestRun('run-live')).toBe(false);
    store.close();
  });

  it('serves no test-only run, item, answer or event on the hidden snapshot, and all of them on the internal one', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    store.submitAnswer('item-test', { submissionId: 'answer-test', expectedRevision: 1, optionIds: ['a'], text: '', actionCompleted: false }, 'user');
    store.submitAnswer('item-live', { submissionId: 'answer-live', expectedRevision: 1, optionIds: ['a'], text: '', actionCompleted: false }, 'user');

    const hidden = store.snapshot([], undefined, { hideTest: true });
    expect(hidden.runs.map((run) => run.id)).toEqual(['run-live']);
    expect(hidden.items.map((item) => item.id)).toEqual(['item-live']);
    expect(hidden.answers.map((answer) => answer.itemId)).toEqual(['item-live']);
    expect(hidden.deliveries.map((delivery) => delivery.runId)).toEqual(['run-live']);
    expect(hidden.recentEvents.every((event) => event.runId !== 'run-test')).toBe(true);
    expect(hidden.recentEvents.some((event) => event.runId === 'run-live')).toBe(true);
    // A scratch workspace with only test runs is not even an orphan row on the owner's view.
    expect(hidden.workspaces.map((view) => view.workspaceId)).toEqual(['ws-live']);
    expect((hidden.answersByClass ?? []).reduce((sum, entry) => sum + entry.count, 0)).toBe(1);
    // One workspace's hidden view hides the same way.
    expect(store.snapshot([], 'ws-scratch', { hideTest: true }).items).toEqual([]);

    const internal = store.snapshot();
    expect(internal.runs.map((run) => run.id).sort()).toEqual(['run-live', 'run-test']);
    expect(internal.items.map((item) => item.id).sort()).toEqual(['item-live', 'item-test']);
    expect((internal.answersByClass ?? []).reduce((sum, entry) => sum + entry.count, 0)).toBe(2);
    store.close();
  });

  it('leaves test-only runs out of the board and pulse reads and of the hidden events feed', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    expect(store.openItemTitles('ws-scratch')).toEqual([]);
    expect(store.openItemTitles('ws-live').map((item) => item.id)).toEqual(['item-live']);
    store.submitAnswer('item-test', { submissionId: 'answer-test', expectedRevision: 1, optionIds: ['a'], text: '', actionCompleted: false }, 'user');
    expect(store.answerTimes('ws-scratch', 0)).toEqual([]);

    const hiddenFeed = store.eventsAfter(0, 200, undefined, { hideTest: true });
    expect(hiddenFeed.events.length).toBeGreaterThan(0);
    expect(hiddenFeed.events.every((event) => event.runId === 'run-live')).toBe(true);
    expect(store.eventsAfter(0, 200).events.some((event) => event.runId === 'run-test')).toBe(true);
    store.close();
  });

  it('keeps the test declaration out of the stored question and in the audited event', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const item = store.attentionItem('item-test');
    expect(item).not.toBeNull();
    expect(Object.hasOwn(item!, 'test')).toBe(false);
    const opened = store.eventsAfter(0, 200).events.find((event) => event.id === 'item-test-open');
    expect(opened?.payload).toMatchObject({ test: true });
    store.close();
  });
});

describe('workspace delete cancels its items (story 57 AC 2)', () => {
  it('cancels every open and candidate item with reason workspace deleted, once, and leaves the rest', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    // A candidate (no review) and an answered item in the same workspace.
    store.applyEvents([open('ws-scratch', 'run-test', 'item-candidate', { review: false })], new Map(), { testWorkspace: true });
    const answered = open('ws-scratch', 'run-test', 'item-answered');
    store.applyEvents([answered], new Map([[answered.eventId, reviewAuthority]]), { testWorkspace: true });
    store.submitAnswer('item-answered', { submissionId: 'answer-1', expectedRevision: 1, optionIds: ['a'], text: '', actionCompleted: false }, 'user');

    expect(store.cancelWorkspaceItems('ws-scratch', 1_800_000_000_000).sort()).toEqual(['item-candidate', 'item-test']);

    for (const id of ['item-candidate', 'item-test']) {
      expect(store.attentionItem(id)).toMatchObject({ state: 'cancelled', resolution: WORKSPACE_DELETED_REASON, revision: 2 });
      const event = store.eventsAfter(0, 200).events.find((entry) => entry.id === `${WORKSPACE_DELETED_EVENT_PREFIX}${id}`);
      expect(event).toMatchObject({ type: 'attention.cancelled', entityId: id, revision: 2, payload: { reason: 'workspace deleted', routing: { state: 'cancelled' } } });
    }
    expect(store.attentionItem('item-answered')?.state).toBe('answered');
    expect(store.attentionItem('item-live')?.state).toBe('open');
    // A second delete finds nothing to cancel and writes no event.
    const cursor = store.eventsAfter(0, 1).cursor;
    expect(store.cancelWorkspaceItems('ws-scratch')).toEqual([]);
    expect(store.eventsAfter(0, 1).cursor).toBe(cursor);
    store.close();
  });
});

describe('the test declaration on the wire (story 57)', () => {
  it('accepts test on run.started and attention.opened, and keeps it beside the normalized question', () => {
    const { events } = parseMissionEventBatch([start('ws-scratch', 'run-test', true), open('ws-scratch', 'run-test', 'item-test', { test: true })]);
    expect(events[0].payload).toMatchObject({ test: true });
    expect(events[1].payload).toMatchObject({ itemId: 'item-test', title: 'Pick one', test: true });
  });

  it('refuses test on attention.updated, a non-boolean test, and the reserved workspace-deleted event namespace', () => {
    const update = { ...open('ws-scratch', 'run-test', 'item-test', { test: true }), eventId: 'up', expectedRevision: 1, type: 'attention.updated' };
    expect(() => parseMissionEventBatch([update])).toThrowError(/test is declared on run.started or attention.opened/);
    expect(() => parseMissionEventBatch([{ ...start('ws-scratch', 'run-test'), payload: { objective: 'x', tabId: 't', test: 'yes' } }]))
      .toThrowError(/expected boolean/i);
    expect(() => parseMissionEventBatch([{ ...start('ws-scratch', 'run-test'), eventId: `${WORKSPACE_DELETED_EVENT_PREFIX}x` }]))
      .toThrowError(/reserved namespace/);
  });
});
