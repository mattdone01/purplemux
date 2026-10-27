import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { MISSION_AUTO_ANSWER_ACTOR } from '@/lib/attention-class';
import type { ICaller } from '@/lib/caller';
import { AUTO_ANSWER_KEY } from '@/lib/mission-control-auto-answer';
import { MissionControlError } from '@/lib/mission-control-errors';
import { MissionControlStore } from '@/lib/mission-control-store';
import { parseMissionEvents } from '@/lib/mission-control-validation';
import type { TMissionProducerEvent } from '@/types/mission-control';

// ADR-0031 §8: the system actor is server-only. A session subject that claims it is
// refused on the human answer route, and no producer event can carry it or take the
// rule's event ID.

const holder = vi.hoisted(() => ({ store: null as MissionControlStore | null }));
vi.mock('@/lib/mission-control-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mission-control-store')>()),
  getMissionControlStore: () => holder.store,
}));
vi.mock('@/lib/workspace-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-token')>()),
  resolveCliScope: () => ({ type: 'workspace', workspaceId: 'ws-a' }),
}));

const binding = { tabId: 'tab-orch', providerId: 'claude', sessionId: 'session-1', runtimeGeneration: 'launch-1' };
let directory = '';

const seed = (store: MissionControlStore): void => {
  const base = { schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', producerAt: 1 };
  const start: TMissionProducerEvent = { ...base, eventId: 'e-start', expectedRevision: 0, bindingGeneration: 0, type: 'run.started', payload: { objective: 'Ship', tabId: binding.tabId } };
  store.applyEvents([start], new Map([[start.eventId, binding]]));
  const opened: TMissionProducerEvent = {
    ...base, eventId: 'e-open', expectedRevision: 0, bindingGeneration: 1, type: 'attention.opened',
    payload: {
      itemId: 'item-a', kind: 'question', title: 'Raise the budget?', context: 'More turns.', storyIds: [],
      options: [{ id: 'raise', label: 'Raise' }, { id: 'stop', label: 'Stop' }], recommendation: null,
      blockingScope: 'story', canContinue: true, class: 'bookkeeping', defaultOptionId: 'raise',
      humanReview: { humanNeed: 'approval', humanReason: 'Owner call.', handling: 'Checked.', reviewerTabId: binding.tabId },
    },
  };
  store.applyEvents([opened], new Map([[opened.eventId, { resolvedIdentity: binding, configuredOrchestratorTabId: binding.tabId }]]));
};

const post = async (sub: string, body: Record<string, unknown>) => {
  const { default: handler } = await import('@/pages/api/mission-control/items/[itemId]/answers');
  const token = await new SignJWT({ sub }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.NEXTAUTH_SECRET));
  const cookie = `session-token=${token}`;
  const state = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.status = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({
    method: 'POST',
    query: { itemId: 'item-a' },
    headers: { cookie, origin: 'http://localhost:8022', host: 'localhost:8022' },
    socket: {},
    body,
  } as unknown as NextApiRequest, res);
  return state as { status: number; body: { code?: string; error?: string } };
};

const answer = (submissionId: string) => ({ submissionId, expectedRevision: 1, optionIds: ['raise'], text: '', actionCompleted: false });

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = 'mission-control-test-secret-at-least-32-bytes';
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-auto-answer-route-'));
  holder.store = new MissionControlStore(path.join(directory, 'mission.sqlite'));
  seed(holder.store);
});

afterEach(() => {
  holder.store?.close();
  holder.store = null;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('POST /api/mission-control/items/{id}/answers: the system actor is server-only', () => {
  it.each([MISSION_AUTO_ANSWER_ACTOR, 'system:orchestration'])('refuses a session subject %s with 403 and records nothing', async (sub) => {
    const r = await post(sub, answer('h-1'));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('forbidden');
    expect(holder.store?.snapshot().answers).toEqual([]);
  });

  it('refuses the rule\'s submission namespace with 400', async () => {
    const r = await post('owner', answer('auto:item-a:1'));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/reserved namespace/);
    expect(holder.store?.snapshot().answers).toEqual([]);
  });

  it('records a human subject as itself, never as the rule', async () => {
    const r = await post('owner', answer('h-1'));
    expect(r.status).toBe(201);
    const snapshot = holder.store!.snapshot();
    expect(snapshot.answers.map((entry) => entry.actor)).toEqual(['owner']);
    expect(snapshot.answersByClass).toEqual([expect.objectContaining({ class: 'bookkeeping', by: 'human', count: 1 })]);
    expect(snapshot.items[0].autoAnswer).toBeNull();
  });
});

describe('producer events cannot post as the system actor', () => {
  const base = { eventId: 'e-x', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 1, producerAt: 1, bindingGeneration: 1 };

  it('refuses an answer.recorded event: producers cannot post answers', () => {
    expect(() => parseMissionEvents([{ ...base, type: 'answer.recorded', payload: { answerId: 'a', actor: MISSION_AUTO_ANSWER_ACTOR } }]))
      .toThrowError(MissionControlError);
  });

  it('refuses an actor field on an attention event', () => {
    expect(() => parseMissionEvents([{ ...base, type: 'attention.cancelled', payload: { itemId: 'item-a', reason: 'x', actor: MISSION_AUTO_ANSWER_ACTOR } }]))
      .toThrowError(MissionControlError);
  });

  it('refuses the rule\'s answer event ID', () => {
    expect(() => parseMissionEvents([{ ...base, eventId: 'answer:auto:item-a:1', type: 'attention.cancelled', payload: { itemId: 'item-a', reason: 'x' } }]))
      .toThrowError(/reserved namespace/);
  });
});

describe('attention.auto-answer.bookkeeping-minutes is written by the admin token only (ruling R2)', () => {
  const caller = (over: Partial<ICaller>): ICaller => ({
    scope: { type: 'workspace', workspaceId: 'ws-a' } as ICaller['scope'],
    workspaceId: 'ws-a', tabId: 'tab-orch', tabName: 'orch', verified: true, identity: 'launch', admin: false, ...over,
  });
  const authority = { isWorkspaceOrchestrator: vi.fn(async () => true), now: () => 1 };

  it('refuses the workspace\'s enabled orchestrator with forbidden and writes nothing', async () => {
    const home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(caller({}), AUTO_ANSWER_KEY, { value: '30' }, authority))
      .rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('admin token only') });
    expect(fs.existsSync(path.join(directory, '.purplemux', 'fleet-config.json'))).toBe(false);
    home.mockRestore();
  });

  it('accepts the admin token and the rule reads the value with its version', async () => {
    const home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
    const { putValue } = await import('@/lib/fleet-config-http');
    const { readFleetConfig, valueOf } = await import('@/lib/fleet-config-store');
    const { readAutoAnswerRule } = await import('@/lib/mission-control-auto-answer-tick');
    await putValue(caller({ admin: true, workspaceId: null, tabId: null, verified: false, identity: 'none' }), AUTO_ANSWER_KEY, { value: '30' }, authority);
    expect(await readAutoAnswerRule(async () => valueOf(await readFleetConfig(), AUTO_ANSWER_KEY))).toEqual({ minutes: 30, version: 1 });
    home.mockRestore();
  });
});

describe('GET /api/cli/api-guide: the auto-answer contract', () => {
  const guide = async (): Promise<string> => {
    const { default: handler } = await import('@/pages/api/cli/api-guide');
    const state = { body: undefined as unknown };
    const res = {
      status() { return this; },
      json(payload: unknown) { state.body = payload; return this; },
      send(payload: unknown) { state.body = payload; return this; },
      setHeader() { return this; },
    } as unknown as NextApiResponse;
    await handler({ method: 'GET', headers: {} } as NextApiRequest, res);
    return String(state.body);
  };

  it('lists the key in "Keys in use" as admin-only and off when unset', async () => {
    const text = await guide();
    const keys = text.slice(text.indexOf('Keys in use:'), text.indexOf('GET /api/cli/fleet-config'));
    expect(keys).toContain(AUTO_ANSWER_KEY);
    expect(keys.replace(/\s+/g, ' ')).toContain('Unset (the default) or any invalid value is off');
    expect(keys.replace(/\s+/g, ' ')).toContain('Admin token only');
  });

  it('documents autoAnswer, autoAnswered and the absence rule in § Mission Control', async () => {
    const text = await guide();
    const section = text.slice(text.indexOf('## Mission Control'), text.indexOf('## Web-browser tabs')).replace(/\s+/g, ' ');
    expect(section).toContain('"autoAnswer": { "rule", "ruleVersion", "appliedOptionId", "at", "note" }');
    expect(section).toContain('"autoAnswered": [{ "itemId", "workspaceId", "runId", "title", "class", "appliedOptionId", "appliedOptionLabel", "at", "note", "itemState" }]');
    expect(section).toContain('An absent field means the server does not report it (not available), never 0');
    expect(section).toContain('"actor": "system:auto-answer"');
  });
});
