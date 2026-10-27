import fs from 'fs/promises';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signSessionToken } from '@/lib/auth';
import { NoteError } from '@/lib/notes-store';
import type { ILeaseHolder } from '@/types/lease';
import { drainLeaseLocks, makeHome, readAudit, resetLeaseGlobals } from '../lib/lease-test-home';

// ADR-0029 §6-§10: the three human coordination routes. Cookie plus this server's Origin; a CLI
// token, no cookie or another Origin is refused; none of them types into a tab. Leases and the
// inbox are the real stores in a scratch HOME; the notes service is a fake (its rules are pinned
// in tests/unit/lib/notes-service.test.ts).

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

// Nothing reaches a pane: every tmux and prompt-delivery function is a spy that must stay unused.
const typed = vi.hoisted(() => vi.fn());
const spyAll = (actual: Record<string, unknown>) => Object.fromEntries(Object.entries(actual)
  .map(([key, value]) => [key, typeof value === 'function' ? (...args: unknown[]) => typed(key, ...args) : value]));
vi.mock('@/lib/tmux', async (importOriginal) => spyAll(await importOriginal()));
vi.mock('@/lib/agent-prompt-delivery', async (importOriginal) => spyAll(await importOriginal()));

const notes = vi.hoisted(() => ({ humanTarget: vi.fn(), sendHuman: vi.fn() }));
vi.mock('@/lib/notes-service', () => ({ getNotesService: async () => notes }));

const HOST = 'purplemux.test';
const ORIGIN = `http://${HOST}`;

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, unknown> };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader(name: string, value: unknown) { state.headers[name] = value; return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

type THeaders = Record<string, string>;

const human = async (extra: THeaders = {}): Promise<THeaders> =>
  ({ cookie: `session-token=${await signSessionToken()}`, host: HOST, origin: ORIGIN, ...extra });

const ROUTES = {
  notes: () => import('@/pages/api/mission-control/notes'),
  'leases/break': () => import('@/pages/api/mission-control/leases/break'),
  'inbox/retry': () => import('@/pages/api/mission-control/inbox/[id]/retry'),
};

const call = async (route: keyof typeof ROUTES, headers: THeaders, body: unknown, query: Record<string, string> = {}, method = 'POST') => {
  const { default: handler } = await ROUTES[route]();
  const { state, res } = fakeResponse();
  await handler({ method, headers, body, query, socket: {} } as unknown as NextApiRequest, res);
  return state as { statusCode: number; body: Record<string, unknown>; headers: Record<string, unknown> };
};

const tabA: ILeaseHolder = { workspaceId: 'ws-a', tabId: 'tab-a', tabName: 'A', verified: true, admin: false };
const authority = { now: () => Date.now(), isWorkspaceOrchestrator: async () => false };

/** A workspace token and a launch tab token of ws-a, minted in the scratch HOME; both resolve to a real scope. */
const agentTokens = async (): Promise<{ workspace: string; tab: string }> => {
  const { getWorkspaceToken, resolveCliScope } = await import('@/lib/workspace-token');
  const { ensureTabToken } = await import('@/lib/tab-token');
  const workspace = getWorkspaceToken('ws-a');
  const tab = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a' }, 'pt-ws-a-tab-a');
  const scope = (token: string) => resolveCliScope({ headers: { 'x-pmux-token': token } } as unknown as NextApiRequest);
  expect(scope(workspace)).toEqual({ type: 'workspace', workspaceId: 'ws-a' });
  expect(scope(tab)).toMatchObject({ type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-a', tabVerified: true });
  return { workspace, tab };
};

/** Each refused call, with the reason it is refused. */
const refusals = async (): Promise<Array<[string, THeaders, number]>> => {
  (globalThis as unknown as { __ptCliToken?: string }).__ptCliToken = 'c'.repeat(64);
  const tokens = await agentTokens();
  return [
    ['a CLI token, no cookie', { 'x-pmux-token': 'c'.repeat(64), host: HOST, origin: ORIGIN }, 401],
    ['a workspace token, no cookie', { 'x-pmux-token': tokens.workspace, host: HOST, origin: ORIGIN }, 401],
    ['a launch tab token, no cookie', { 'x-pmux-token': tokens.tab, host: HOST, origin: ORIGIN }, 401],
    ['no cookie', { host: HOST, origin: ORIGIN }, 401],
    ['another Origin', await human({ origin: 'http://evil.test' }), 403],
    ['no Origin and no Fetch Metadata', { cookie: (await human()).cookie, host: HOST }, 403],
    ['cross-site Fetch Metadata with a forged Origin', await human({ 'sec-fetch-site': 'cross-site' }), 403],
  ];
};

const TOKEN_GLOBALS = ['__ptWorkspaceTokens', '__ptTabTokens', '__ptTabTokenLock', '__ptTabTokenRevokeInstalled'];

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetLeaseGlobals();
  for (const key of ['__ptInboxLock', ...TOKEN_GLOBALS]) delete (globalThis as Record<string, unknown>)[key];
  process.env.NEXTAUTH_SECRET = 'mission-control-test-secret-at-least-32-bytes';
  mockHome.value = await makeHome();
  notes.humanTarget.mockImplementation(async (to: { toWorkspace?: unknown; toEpic?: unknown }) => {
    if (to.toEpic === 'unowned') throw new NoteError('note-target-missing', 'nobody live holds epic:unowned');
    return (to.toWorkspace ?? 'ws-epic') as string;
  });
  notes.sendHuman.mockImplementation(async (actor: string, ws: string, input: { subject: string }) =>
    ({ id: 'n-1', subject: input.subject, admission: { mode: 'human', humanActor: actor, targetWorkspaceId: ws } }));
});

afterEach(async () => {
  await drainLeaseLocks();
  resetLeaseGlobals();
  for (const key of TOKEN_GLOBALS) delete (globalThis as Record<string, unknown>)[key];
  await fs.rm(mockHome.value, { recursive: true, force: true });
  expect(typed).not.toHaveBeenCalled();
});

describe('POST /api/mission-control/notes (ADR-0029 §6)', () => {
  it('sends with the human admission as the session subject; toEpic resolves to the holder workspace', async () => {
    const r = await call('notes', await human(), { toWorkspace: 'ws-b', subject: 'Pause', body: 'Hold merges', externalKey: 'portfolio:action:x', fromEpic: 'e' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['Cache-Control']).toBe('no-store');
    expect(r.body.note).toMatchObject({ admission: { mode: 'human', humanActor: 'user', targetWorkspaceId: 'ws-b' } });
    // Only subject and body reach the service: no portfolio key, no epic claim.
    expect(notes.sendHuman).toHaveBeenCalledWith('user', 'ws-b', { subject: 'Pause', body: 'Hold merges' });

    await call('notes', await human(), { toEpic: 'flow', subject: 's', body: 'b' });
    expect(notes.humanTarget).toHaveBeenLastCalledWith({ toWorkspace: undefined, toEpic: 'flow' });
    expect(notes.sendHuman).toHaveBeenLastCalledWith('user', 'ws-epic', { subject: 's', body: 'b' });
  });

  it('answers each refusal with its code; note-too-large is 400 on this route', async () => {
    const unowned = await call('notes', await human(), { toEpic: 'unowned', subject: 's', body: 'b' });
    expect(unowned).toMatchObject({ statusCode: 400, body: { code: 'note-target-missing' } });
    expect(notes.sendHuman).not.toHaveBeenCalled();

    const cases: Array<[NoteError, number]> = [
      [new NoteError('note-too-large', 'body is 16385 bytes'), 400],
      [new NoteError('note-invalid', 'subject is required'), 400],
      [new NoteError('note-target-missing', 'no workspace ws-x'), 400],
      [new NoteError('note-cap', 'this sender already has 50 open notes'), 409],
    ];
    for (const [err, status] of cases) {
      notes.sendHuman.mockRejectedValueOnce(err);
      const r = await call('notes', await human(), { toWorkspace: 'ws-b', subject: 's', body: 'b' });
      expect(r).toMatchObject({ statusCode: status, body: { code: err.code, error: err.message } });
    }
  });

  it('refuses a CLI, workspace or tab token, no cookie and another Origin, and sends nothing', async () => {
    for (const [why, headers, status] of await refusals()) {
      const r = await call('notes', headers, { toWorkspace: 'ws-b', subject: 's', body: 'b' });
      expect(r.statusCode, why).toBe(status);
    }
    expect(notes.sendHuman).not.toHaveBeenCalled();
    expect((await call('notes', await human(), {}, {}, 'GET')).statusCode).toBe(405);
  });
});

describe('POST /api/mission-control/leases/break (ADR-0029 §8)', () => {
  const acquire = async (name: string) => (await import('@/lib/lease-store')).acquireLease({ name }, tabA, authority);

  it('breaks as the admin break does and audits the human session subject', async () => {
    await acquire('merge:x/y');
    const r = await call('leases/break', await human(), { name: 'merge:x/y', reason: 'holder crashed mid-merge' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['Cache-Control']).toBe('no-store');
    expect(r.body.broken).toMatchObject({ name: 'merge:x/y', holder: { workspaceId: 'ws-a', tabId: 'tab-a' } });
    expect(await (await import('@/lib/lease-store')).findLease('merge:x/y')).toBeNull();
    await drainLeaseLocks();
    expect((await readAudit(mockHome.value)).at(-1)).toMatchObject({
      event: 'lease-release', name: 'merge:x/y', reason: 'broken', breakReason: 'holder crashed mid-merge', by: { human: 'user' },
    });
  });

  it('answers 400 invalid-request for an empty or over-long reason or a bad name, and 404 for no lease', async () => {
    await acquire('merge:x/y');
    for (const body of [{ name: 'merge:x/y', reason: '' }, { name: 'merge:x/y', reason: '   ' }, { name: 'merge:x/y' },
      { name: 'merge:x/y', reason: 'r'.repeat(501) }, { name: 'not a lease', reason: 'r' }]) {
      const r = await call('leases/break', await human(), body);
      expect(r, JSON.stringify(body)).toMatchObject({ statusCode: 400, body: { code: 'invalid-request' } });
    }
    expect(await (await import('@/lib/lease-store')).findLease('merge:x/y')).not.toBeNull();
    const missing = await call('leases/break', await human(), { name: 'merge:none/here', reason: 'r' });
    expect(missing).toMatchObject({ statusCode: 404, body: { code: 'lease-not-found' } });
  });

  it('refuses a CLI, workspace or tab token, no cookie and another Origin, and breaks nothing', async () => {
    await acquire('merge:x/y');
    for (const [why, headers, status] of await refusals()) {
      const r = await call('leases/break', headers, { name: 'merge:x/y', reason: 'r' });
      expect(r.statusCode, why).toBe(status);
    }
    expect(await (await import('@/lib/lease-store')).findLease('merge:x/y')).not.toBeNull();
  });
});

describe('POST /api/mission-control/inbox/{id}/retry (ADR-0029 §7, consult Q1)', () => {
  /** A held notice for another workspace's tab, in the scratch HOME's real inbox. */
  const heldNotice = async (reason: string, dedupeKey = `k-${reason}`) => {
    const inbox = await import('@/lib/inbox-store');
    const { item } = await inbox.enqueueNotice({
      kind: 'watch', targetWorkspaceId: 'ws-other', targetTabId: 'tab-o', dedupeKey,
      fields: { watchId: 'w-abcd1234', target: 'merge:o/r', notice: 'free' },
    });
    await inbox.mutateInbox((state) => ({ state: inbox.holdInState(state, item.id, reason, Date.now()), value: null }));
    return item.id;
  };
  const stored = async (id: string) => (await (await import('@/lib/inbox-store')).readInboxState()).items.find((i) => i.id === id);

  it('re-queues a refusal-budget or 24 h hold of any workspace once', async () => {
    for (const reason of ['composer-not-empty (30 refusals)', 'never ready (undelivered after 24 h)']) {
      const id = await heldNotice(reason);
      const r = await call('inbox/retry', await human(), undefined, { id });
      expect(r.statusCode, reason).toBe(200);
      expect(r.headers['Cache-Control']).toBe('no-store');
      expect(r.body.item).toMatchObject({ id, state: 'queued', attempts: 0, heldReason: null });
      expect(await stored(id)).toMatchObject({ state: 'queued' });
      const again = await call('inbox/retry', await human(), undefined, { id });
      expect(again).toMatchObject({ statusCode: 409, body: { code: 'inbox-not-held' } });
    }
  });

  it('answers 409 inbox-not-retryable with the reason for a hold a retry could double or never deliver, and changes nothing', async () => {
    for (const [reason, token] of [['stranded-in-composer', 'stranded-in-composer'],
      ['transport-uncertain:tmux paste failed', 'transport-uncertain'], ['target-not-agent', 'target-not-agent']]) {
      const id = await heldNotice(reason);
      const before = await stored(id);
      const r = await call('inbox/retry', await human(), undefined, { id });
      expect(r, reason).toMatchObject({ statusCode: 409, body: { code: 'inbox-not-retryable', reason: token } });
      expect(await stored(id)).toEqual(before);
    }
  });

  it('answers 404 inbox-not-found for an unknown id', async () => {
    const r = await call('inbox/retry', await human(), undefined, { id: 'i-nothere00' });
    expect(r).toMatchObject({ statusCode: 404, body: { code: 'inbox-not-found' } });
  });

  it('refuses a CLI, workspace or tab token, no cookie and another Origin, and re-queues nothing', async () => {
    const id = await heldNotice('composer-not-empty (30 refusals)');
    for (const [why, headers, status] of await refusals()) {
      const r = await call('inbox/retry', headers, undefined, { id });
      expect(r.statusCode, why).toBe(status);
    }
    expect(await stored(id)).toMatchObject({ state: 'held' });
    expect((await call('inbox/retry', await human(), undefined, { id }, 'GET')).statusCode).toBe(405);
  });
});
