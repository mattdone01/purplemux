import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0048 round 1: PATCH { keep } runs the real `authorizeWorkspaceInput`. A tab of another workspace is refused 403
// before anything is written; the Scrum Master selection is the only foreign route (ADR-0046), stubbed off here.

const mockHome = vi.hoisted(() => ({ value: '' }));
const scope = vi.hoisted(() => ({ value: null as unknown }));
const layout = vi.hoisted(() => ({ setTabKeep: vi.fn(async () => true) }));
const selection = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/workspace-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-token')>()),
  resolveCliScope: () => scope.value,
}));
vi.mock('@/lib/scrum-master-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/scrum-master-access')>()),
  selectedScrumMasterScope: async () => selection.value,
}));
vi.mock('@/lib/layout-store', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/layout-store')>()), setTabKeep: layout.setTabKeep }));

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const patch = async (workspaceId: string) => {
  const { state, res } = fakeResponse();
  const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]');
  await handler({
    method: 'PATCH', url: `/api/cli/tabs/tab-w?workspaceId=${workspaceId}`, headers: {},
    query: { workspaceId, tabId: 'tab-w' }, body: { keep: { reason: 'mine' } },
  } as unknown as NextApiRequest, res);
  return state;
};

describe('PATCH { keep } authorization (real authorizeWorkspaceInput)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    selection.value = null;
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-keep-auth-'));
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('refuses a tab of another workspace with 403 and writes nothing', async () => {
    scope.value = { type: 'workspace', workspaceId: 'ws-other', tabId: 'tab-x' };
    const state = await patch('ws-1');
    expect(state.statusCode).toBe(403);
    expect(state.body).toMatchObject({ code: 'forbidden', error: expect.stringContaining('Agent mutations are confined to the caller workspace') });
    expect(layout.setTabKeep).not.toHaveBeenCalled();
  });

  it('refuses a caller with no token scope with 403', async () => {
    scope.value = null;
    expect((await patch('ws-1')).statusCode).toBe(403);
    expect(layout.setTabKeep).not.toHaveBeenCalled();
  });

  it('lets the own workspace through to the tab lookup', async () => {
    scope.value = { type: 'workspace', workspaceId: 'ws-1', tabId: 'tab-x' };
    // No registry and no layout in the temp home: the route answers 404 for the tab, past the authorization.
    expect((await patch('ws-1')).statusCode).toBe(404);
    expect(layout.setTabKeep).not.toHaveBeenCalled();
  });
});
