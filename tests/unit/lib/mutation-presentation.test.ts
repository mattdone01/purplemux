import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const home = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => home.value }, homedir: () => home.value };
});
vi.mock('@/lib/cli-token', () => ({ verifyTokenValue: () => false }));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: vi.fn(async () => null) }));
vi.mock('@/lib/inbox-store', async (original) => ({ ...await original<typeof import('@/lib/inbox-store')>(), readInboxState: vi.fn(async () => ({ items: [] })) }));

const req = (method = 'POST', workspaceId = 'ws-other') => ({ method, headers: { 'x-pmux-token': 'hook-token' }, query: { workspaceId, id: 'i-missing' }, body: { workspaceId } } as unknown as NextApiRequest);
const res = () => {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json() { emitter.emit('finish'); return this; },
    send() { emitter.emit('finish'); return this; },
    setHeader() {},
  }) as unknown as NextApiResponse;
};
const tokenFile = () => path.join(home.value, '.purplemux/tab-tokens.json');
let original: string;
const settled = async () => { await (globalThis as { __ptTabTokenLock?: Promise<void> }).__ptTabTokenLock; };
const reset = () => {
  const state = globalThis as Record<string, unknown>;
  for (const key of ['__ptTabTokens', '__ptTabTokenLock', '__ptWorkspaceTokens']) delete state[key];
};
beforeEach(() => {
  vi.resetModules(); reset();
  home.value = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-presentation-'));
  fs.mkdirSync(path.join(home.value, '.purplemux'));
  original = JSON.stringify({ 'tab-hook': { token: 'hook-token', workspaceId: 'ws-own', sessionName: 'session', createdAt: '2026-10-05', origin: 'hook' } });
  fs.writeFileSync(tokenFile(), original);
});
afterEach(async () => { await settled(); reset(); fs.rmSync(home.value, { recursive: true, force: true }); });
const unchanged = async () => {
  await settled();
  const { getTabTokenRecord } = await import('@/lib/tab-token');
  expect(getTabTokenRecord('tab-hook')?.presentedAt).toBeUndefined();
  expect(fs.readFileSync(tokenFile(), 'utf8')).toBe(original);
};

describe('scope and caller resolution are read-only until a successful route response', () => {
  it('plain resolution never records presentation', async () => {
    const { resolveCliScope } = await import('@/lib/workspace-token');
    expect(resolveCliScope(req())).toMatchObject({ workspaceId: 'ws-own', tabIdentity: 'hook' });
    await unchanged();
  });
  it.each(['GET', 'POST', 'PATCH', 'DELETE'])('a denied %s preserves disk and in-memory identity', async (method) => {
    const { authorizeWorkspace } = await import('@/lib/cli-utils');
    expect(await authorizeWorkspace(req(method), res(), 'ws-other')).toBeNull();
    await unchanged();
  });
  it('records only after successful completion, once even with repeated resolution', async () => {
    const { resolveCliScope } = await import('@/lib/workspace-token');
    const response = res();
    resolveCliScope(req(), { response }); resolveCliScope(req(), { response });
    await unchanged();
    response.status(200).json({});
    await settled();
    expect(JSON.parse(fs.readFileSync(tokenFile(), 'utf8'))['tab-hook'].presentedAt).toEqual(expect.any(String));
  });
  it('a successful API route records the first accepted presentation', async () => {
    const { default: handler } = await import('@/pages/api/cli/api-guide');
    const response = res();
    await handler(req('GET'), response);
    expect(response.statusCode).toBe(200);
    await settled();
    expect(JSON.parse(fs.readFileSync(tokenFile(), 'utf8'))['tab-hook'].presentedAt).toEqual(expect.any(String));
  });
  it('an authorized scope followed by route-specific refusal never records', async () => {
    const { authorizeWorkspace } = await import('@/lib/cli-utils');
    const response = res();
    expect(await authorizeWorkspace(req(), response, 'ws-own')).not.toBeNull();
    response.status(403).json({});
    await unchanged();
  });
  it.each([
    ['peer read', 'GET', () => import('@/pages/api/cli/workspaces/[workspaceId]/peers')],
    ['foreign Mission Control event', 'POST', () => import('@/pages/api/cli/mission-control/events')],
    ['foreign Mission Control read', 'GET', () => import('@/pages/api/cli/mission-control/index')],
    ['tab identity', 'POST', () => import('@/pages/api/cli/tab-identity')],
    ['foreign inbox retry', 'POST', () => import('@/pages/api/cli/inbox/[id]/retry')],
    ['tab creation', 'POST', () => import('@/pages/api/cli/tabs')],
  ] as const)('%s denial preserves disk and identity', async (_label, method, load) => {
    const { default: handler } = await load();
    const response = res();
    await handler(req(method), response);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    await unchanged();
  });
  it('Mission Control rejects a foreign event payload after local scope authentication without recording', async () => {
    const { default: handler } = await import('@/pages/api/cli/mission-control/events');
    const request = req('POST', 'ws-own');
    request.body = { events: [{
      eventId: 'event-foreign', schemaVersion: 1, workspaceId: 'ws-other', runId: 'run-a',
      expectedRevision: 0, producerAt: 1700000000000, bindingGeneration: 0,
      type: 'run.started', payload: { objective: 'Ship', tabId: 'tab-other' },
    }] };
    const response = res();
    await handler(request, response);
    expect(response.statusCode).toBe(403);
    await unchanged();
  });
  it('caller-based authorization denial also preserves identity', async () => {
    const { requireCaller } = await import('@/lib/lease-http');
    const response = res();
    expect(await requireCaller(req(), response)).not.toBeNull();
    response.status(403).json({});
    await unchanged();
  });
});
