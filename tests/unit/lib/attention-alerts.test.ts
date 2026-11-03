import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTENTION_ALERT_MEMORY,
  createAttentionAlertState,
  dispatchAttentionOpenedAlerts,
  openedForHuman,
} from '@/lib/attention-alerts';
import type { IAttentionAlertDeps, IAttentionAlertState } from '@/lib/attention-alerts';
import type { TAlertDraft } from '@/lib/alert-policy';
import { MissionControlStore } from '@/lib/mission-control-store';
import type { IMissionEvent, TMissionHumanReviewInput, TMissionProducerEvent } from '@/types/mission-control';
import type { ITab, IWorkspace } from '@/types/terminal';

// An item opened for the human (humanNeed is not `none`) sends one `attention-opened` alert that
// names the item. The events come from a real store, so the payload shape is the committed one.

const binding = { tabId: 'tab-orch', providerId: 'claude' as const, sessionId: 'session-1', runtimeGeneration: 'launch-1' };
const authority = { resolvedIdentity: binding, configuredOrchestratorTabId: binding.tabId };
const base = { schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', producerAt: 1_700_000_000_000 };
const question = {
  kind: 'question' as const, title: '  Raise the budget for lane H-3?  ', context: 'More turns.', storyIds: [],
  options: [{ id: 'raise', label: 'Raise' }, { id: 'stop', label: 'Stop' }], recommendation: null,
  blockingScope: 'story' as const, canContinue: true,
};
const needsOwner: TMissionHumanReviewInput = { humanNeed: 'decision', humanReason: 'Owner call.', handling: 'Checked.', reviewerTabId: binding.tabId };
const noOwner: TMissionHumanReviewInput = { humanNeed: 'none', handling: 'SM handles it.', reviewerTabId: binding.tabId };

const workspace: IWorkspace = {
  id: 'ws-a', name: 'Treasury v2', directories: ['/tmp/ws-a'],
  orchestration: { enabled: true, orchestratorTabId: 'tab-orch' },
} as IWorkspace;
const tabs: Record<string, ITab> = {
  'tab-orch': { id: 'tab-orch', sessionName: 's-orch', name: 'orchestrator', order: 0, panelType: 'claude-code' },
  'tab-sm': { id: 'tab-sm', sessionName: 's-sm', name: 'scrum master', order: 1, panelType: 'codex-cli' },
};

let directory = '';
let store: MissionControlStore;
let state: IAttentionAlertState;
let sent: Array<{ draft: TAlertDraft; workspaceDir: string | null | undefined }>;

const deps = (overrides: Partial<IAttentionAlertDeps> = {}): IAttentionAlertDeps => ({
  workspace: async (id) => (id === 'ws-a' ? workspace : null),
  findTab: async (_ws, tabId) => tabs[tabId] ?? null,
  providerOf: async (tab) => (tab.panelType === 'codex-cli' ? 'codex' : 'claude'),
  dispatch: async (draft, ctx) => { sent.push({ draft, workspaceDir: ctx.workspaceDir }); },
  ...overrides,
});

const open = (eventId: string, itemId: string, humanReview?: TMissionHumanReviewInput): Extract<TMissionProducerEvent, { type: 'attention.opened' }> => ({
  ...base, eventId, expectedRevision: 0, bindingGeneration: 1, type: 'attention.opened',
  payload: { itemId, ...question, ...(humanReview ? { humanReview } : {}) },
});

const apply = (events: TMissionProducerEvent[]): { events: IMissionEvent[]; fresh: Set<string> } => {
  const fresh = store.unreplayedEventIds(events);
  const map = new Map(events.map((e) => [e.eventId, authority]));
  return { events: store.applyEvents(events, map).events, fresh };
};

const run = (applied: { events: IMissionEvent[]; fresh: Set<string> }, openerTabId: string | null = null, d = deps()) =>
  dispatchAttentionOpenedAlerts({ ...applied, openerTabId }, d, state);

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-attention-alerts-'));
  store = new MissionControlStore(path.join(directory, 'mission.sqlite'));
  const start: TMissionProducerEvent = { ...base, eventId: 'e-start', expectedRevision: 0, bindingGeneration: 0, type: 'run.started', payload: { objective: 'Ship', tabId: binding.tabId } };
  store.applyEvents([start], new Map([[start.eventId, binding]]));
  state = createAttentionAlertState();
  sent = [];
});

afterEach(() => {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('dispatchAttentionOpenedAlerts', () => {
  it('sends one attention-opened alert naming the item, its trimmed title and the opening tab', async () => {
    const drafts = await run(apply([open('e-1', 'item-1', needsOwner)]), 'tab-sm');

    expect(drafts).toHaveLength(1);
    expect(sent).toEqual([{
      draft: {
        kind: 'attention-opened',
        itemId: 'item-1',
        title: 'Mission Control: answer needed',
        body: 'Raise the budget for lane H-3?',
        tabId: 'tab-sm',
        tabName: 'scrum master',
        providerId: 'codex',
        isOrchestrator: false,
        workspaceId: 'ws-a',
        workspaceName: 'Treasury v2',
        at: expect.any(Number),
      },
      workspaceDir: '/tmp/ws-a',
    }]);
  });

  it('names the orchestrator tab when the server resolved no opener', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner)]), null);

    expect(sent[0].draft).toMatchObject({ tabId: 'tab-orch', tabName: 'orchestrator', providerId: 'claude', isOrchestrator: true, itemId: 'item-1' });
  });

  it('sends nothing for an item whose humanNeed is none, or with no human review at all', async () => {
    await run(apply([open('e-1', 'item-1', noOwner), open('e-2', 'item-2')]));

    expect(sent).toEqual([]);
  });

  it('sends nothing for a replayed event: the same request again finds it in the store', async () => {
    const event = open('e-1', 'item-1', needsOwner);
    await run(apply([event]));
    const fresh = createAttentionAlertState();
    sent = [];

    const replay = apply([event]);
    expect(replay.fresh.size).toBe(0);
    await dispatchAttentionOpenedAlerts({ ...replay, openerTabId: null }, deps(), fresh);

    expect(sent).toEqual([]);
  });

  it('sends once per item when two concurrent requests both saw the event as fresh', async () => {
    const event = open('e-1', 'item-1', needsOwner);
    const first = apply([event]);
    await run(first);
    await run({ events: first.events, fresh: first.fresh });

    expect(sent).toHaveLength(1);
  });

  it('sends nothing for attention.updated, an update that opens a candidate included', async () => {
    await run(apply([open('e-1', 'item-1', noOwner)]));
    const update: TMissionProducerEvent = {
      ...base, eventId: 'e-2', expectedRevision: 1, bindingGeneration: 1, type: 'attention.updated',
      payload: { itemId: 'item-1', ...question, humanReview: needsOwner },
    };
    const applied = apply([update]);
    expect(applied.events[0].type).toBe('attention.updated');
    await run(applied);

    expect(sent).toEqual([]);
  });

  it('sends nothing for a cancel', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner)]));
    sent = [];
    const cancel: TMissionProducerEvent = {
      ...base, eventId: 'e-2', expectedRevision: 1, bindingGeneration: 1, type: 'attention.cancelled',
      payload: { itemId: 'item-1', reason: 'done elsewhere' },
    };
    await run(apply([cancel]));

    expect(sent).toEqual([]);
  });

  it('sends one alert per opened item of one batch', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner), open('e-2', 'item-2', needsOwner)]));

    expect(sent.map((s) => s.draft.itemId)).toEqual(['item-1', 'item-2']);
  });

  it('keeps going when the workspace, the tab or the provider cannot be read', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner)]), 'tab-gone', deps({
      workspace: async () => { throw new Error('store down'); },
      findTab: async () => { throw new Error('layout down'); },
    }));

    expect(sent[0].draft).toMatchObject({ tabId: 'tab-gone', tabName: '', workspaceName: '', providerId: 'claude', isOrchestrator: false, itemId: 'item-1' });
    expect(sent[0].workspaceDir).toBeNull();
  });

  it('falls back to the claude provider when the provider read fails', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner)]), 'tab-sm', deps({ providerOf: async () => { throw new Error('registry down'); } }));

    expect(sent[0].draft).toMatchObject({ tabId: 'tab-sm', providerId: 'claude' });
  });

  it('names no tab when there is neither an opener nor an orchestrator', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner)]), null, deps({ workspace: async () => ({ ...workspace, orchestration: undefined }) }));

    expect(sent[0].draft).toMatchObject({ tabId: '', tabName: '', isOrchestrator: false });
  });

  it('a failed dispatch is logged and does not retry the item', async () => {
    const dispatch = vi.fn(async () => { throw new Error('channel down'); });
    const applied = apply([open('e-1', 'item-1', needsOwner)]);
    expect(await run(applied, null, deps({ dispatch }))).toEqual([]);
    expect(await run(applied, null, deps({ dispatch }))).toEqual([]);

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('remembers a bounded number of items', async () => {
    for (let i = 0; i < ATTENTION_ALERT_MEMORY + 5; i += 1) state.alerted.add(`ws-x/i-${i}`);
    await run(apply([open('e-1', 'item-1', needsOwner)]));

    expect(state.alerted.size).toBe(ATTENTION_ALERT_MEMORY);
    expect(state.alerted.has('ws-a/item-1')).toBe(true);
  });
});

describe('openedForHuman', () => {
  const event = (overrides: Partial<IMissionEvent> = {}, payload: Record<string, unknown> = {}): IMissionEvent => ({
    seq: 1, id: 'e', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', entityId: 'item-e', revision: 1,
    type: 'attention.opened', producerAt: 1, committedAt: 2,
    payload: { itemId: 'item-e', title: 'T', humanReview: { humanNeed: 'approval' }, routing: { state: 'open' }, ...payload },
    ...overrides,
  });

  it('reads an open item with a human need', () => {
    expect(openedForHuman(event())).toEqual({ workspaceId: 'ws-a', itemId: 'item-e', title: 'T', at: 2 });
  });

  it('refuses another type, another revision, a candidate, humanNeed none and a missing review', () => {
    expect(openedForHuman(event({ type: 'attention.updated' }))).toBeNull();
    expect(openedForHuman(event({ revision: 2 }))).toBeNull();
    expect(openedForHuman(event({}, { routing: { state: 'candidate' } }))).toBeNull();
    expect(openedForHuman(event({}, { humanReview: { humanNeed: 'none' } }))).toBeNull();
    expect(openedForHuman(event({}, { humanReview: undefined }))).toBeNull();
    expect(openedForHuman(event({}, { routing: null }))).toBeNull();
  });

  it('falls back to the entity id and a null title', () => {
    expect(openedForHuman(event({}, { itemId: undefined, title: 7 }))).toEqual({ workspaceId: 'ws-a', itemId: 'item-e', title: null, at: 2 });
  });
});
