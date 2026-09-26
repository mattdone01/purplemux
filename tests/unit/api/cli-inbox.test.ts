import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '' }));
const auth = vi.hoisted(() => ({
  scope: { type: 'workspace', workspaceId: 'ws-1' } as { type: 'admin' } | { type: 'workspace'; workspaceId: string } | null,
  allowRead: true,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: () => auth.scope }));
vi.mock('@/lib/cli-utils', () => ({
  authorizeWorkspace: async (_req: unknown, res: NextApiResponse) => {
    if (auth.allowRead) return auth.scope;
    res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    return null;
  },
}));

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const seed = async () => {
  const store = await import('@/lib/inbox-store');
  const q = await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-a', dedupeKey: 'q', fields: { resumeId: 'r-queued' } });
  const h = await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-b', dedupeKey: 'h', fields: { resumeId: 'r-heldd1' } });
  const d = await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-c', dedupeKey: 'd', fields: { resumeId: 'r-deliv1' } });
  const other = await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-2', targetTabId: 'tab-x', dedupeKey: 'o', fields: { resumeId: 'r-other1' } });
  await store.mutateInbox((state) => ({ state: store.holdInState(state, h.item.id, 'composer-not-empty (30 refusals)', Date.now()), value: null }));
  await store.mutateInbox((state) => ({ state: store.deliverInState(state, d.item.id, Date.now()), value: null }));
  return { q: q.item.id, h: h.item.id, d: d.item.id, other: other.item.id };
};

describe('inbox routes (ADR-0012)', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-inbox-api-'));
    auth.scope = { type: 'workspace', workspaceId: 'ws-1' };
    auth.allowRead = true;
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const list = async (query: Record<string, string>) => {
    const { state, res } = fakeResponse();
    const { default: handler } = await import('@/pages/api/cli/inbox');
    await handler({ method: 'GET', query } as unknown as NextApiRequest, res);
    return state;
  };

  const retry = async (id: string) => {
    const { state, res } = fakeResponse();
    const { default: handler } = await import('@/pages/api/cli/inbox/[id]/retry');
    await handler({ method: 'POST', query: { id } } as unknown as NextApiRequest, res);
    return state;
  };

  it('lists queued and held items of the workspace; --all adds delivered; never another workspace', async () => {
    const ids = await seed();
    const open = await list({ workspaceId: 'ws-1' });
    expect(open.statusCode).toBe(200);
    expect((open.body as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual([ids.q, ids.h]);
    const all = await list({ workspaceId: 'ws-1', all: '1' });
    expect((all.body as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual([ids.q, ids.h, ids.d]);
  });

  it('refuses a list outside the caller\'s read scope and a missing workspaceId', async () => {
    auth.allowRead = false;
    expect((await list({ workspaceId: 'ws-2' })).statusCode).toBe(403);
    auth.allowRead = true;
    expect((await list({})).statusCode).toBe(400);
  });

  it('re-queues a held item for the target workspace\'s token and for admin', async () => {
    const ids = await seed();
    const done = await retry(ids.h);
    expect(done.statusCode).toBe(200);
    expect(done.body).toMatchObject({ item: { id: ids.h, state: 'queued', attempts: 0 } });
    const store = await import('@/lib/inbox-store');
    await store.mutateInbox((s) => ({ state: store.holdInState(s, ids.h, 'x', Date.now()), value: null }));
    auth.scope = { type: 'admin' };
    expect((await retry(ids.h)).statusCode).toBe(200);
  });

  it('answers inbox-not-held and inbox-not-found with their codes, and 404s another workspace\'s item', async () => {
    const ids = await seed();
    expect(await retry(ids.q)).toMatchObject({ statusCode: 409, body: { code: 'inbox-not-held' } });
    expect(await retry('i-nothing12')).toMatchObject({ statusCode: 404, body: { code: 'inbox-not-found' } });
    auth.scope = { type: 'workspace', workspaceId: 'ws-2' };
    // Another workspace's item answers like a missing one.
    expect(await retry(ids.h)).toMatchObject({ statusCode: 404, body: { code: 'inbox-not-found' } });
    auth.scope = null;
    expect(await retry(ids.h)).toMatchObject({ statusCode: 403 });
  });
});
