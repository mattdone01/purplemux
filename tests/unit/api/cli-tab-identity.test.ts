import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILayoutData, ITab } from '@/types/terminal';

// POST /api/cli/tab-identity (story 36, architect ruling): a pre-token tab's
// SessionStart hook takes a hook-time identity with the pane's workspace token.

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/tmux', () => ({
  createSession: vi.fn(async () => {}),
  hasSession: vi.fn(async () => true),
  killSession: vi.fn(async () => {}),
  listSessions: vi.fn(async () => []),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sendKeys: vi.fn(async () => {}),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

const resetGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  for (const key of [
    '__ptTabLifecycle', '__ptTabTokens', '__ptTabTokenLock', '__ptTabTokenRevokeInstalled',
    '__ptLayoutContentCache', '__ptLayoutLock', '__ptWorkspaceTokens', '__ptCliToken',
    '__purplemuxWorkspaceLock', '__purplemuxWorkspacesContentCache',
  ]) delete g[key];
};

const tab = (wsId: string, id: string, panelType?: ITab['panelType']): ITab => ({
  id, name: id, order: 0, sessionName: `pt-${wsId}-pane-1-${id}`, ...(panelType ? { panelType } : {}),
});

const writeLayout = async (wsId: string, tabs: ITab[]) => {
  const dir = path.join(mockHome.value, '.purplemux', 'workspaces', wsId);
  await fs.mkdir(dir, { recursive: true });
  const layout: ILayoutData = { root: { type: 'pane', id: 'pane-1', activeTabId: tabs[0].id, tabs }, activePaneId: 'pane-1', updatedAt: '2026-09-26T00:00:00.000Z' };
  await fs.writeFile(path.join(dir, 'layout.json'), JSON.stringify(layout));
};

const post = async (token: string | null, body: unknown, method = 'POST') => {
  const { default: handler } = await import('@/pages/api/cli/tab-identity');
  const state = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.status = code; return this; },
    json(b: unknown) { state.body = b; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({ method, headers: token ? { 'x-pmux-token': token } : {}, body, query: {} } as unknown as NextApiRequest, res);
  return state as { status: number; body: Record<string, unknown> };
};

describe('POST /api/cli/tab-identity', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-tab-identity-'));
    await fs.mkdir(path.join(mockHome.value, '.purplemux'), { recursive: true });
    await fs.writeFile(path.join(mockHome.value, '.purplemux', 'workspaces.json'), JSON.stringify({
      workspaces: [{ id: 'ws-a', name: 'A', directories: ['/a'] }, { id: 'ws-b', name: 'B', directories: ['/b'] }],
      groups: [], sidebarCollapsed: false, sidebarWidth: 240, updatedAt: '2026-09-26T00:00:00.000Z',
    }));
    await writeLayout('ws-a', [tab('ws-a', 'tab-old'), tab('ws-a', 'tab-new'), tab('ws-a', 'tab-web', 'web-browser')]);
    await writeLayout('ws-b', [tab('ws-b', 'tab-b1')]);
  });

  afterEach(async () => {
    await (globalThis as { __ptTabTokenLock?: Promise<void> }).__ptTabTokenLock;
    resetGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const wsToken = async (ws: string) => (await import('@/lib/workspace-token')).getWorkspaceToken(ws);

  it('mints a hook-time token for a live tab of the workspace, then answers the same token again', async () => {
    const first = await post(await wsToken('ws-a'), { session: 'pt-ws-a-pane-1-tab-old' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ tabId: 'tab-old', workspaceId: 'ws-a', identity: 'hook' });
    expect(first.body.token).toMatch(/^[0-9a-f]{64}$/);
    const again = await post(await wsToken('ws-a'), { session: 'pt-ws-a-pane-1-tab-old' });
    expect(again.body.token).toBe(first.body.token);
    const { tabIdentityOf } = await import('@/lib/tab-token');
    expect(tabIdentityOf('ws-a', 'tab-old')).toBe('hook');
  });

  it('refuses a tab that has its launch identity (409) and never returns that token', async () => {
    const { ensureTabToken } = await import('@/lib/tab-token');
    const launch = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-new' }, 'pt-ws-a-pane-1-tab-new');
    const r = await post(await wsToken('ws-a'), { session: 'pt-ws-a-pane-1-tab-new' });
    expect(r).toEqual({ status: 409, body: { error: 'tab tab-new already has its launch identity', code: 'tab-has-launch-identity' } });
    expect(JSON.stringify(r.body)).not.toContain(launch);
  });

  it('refuses the admin token, a tab token, and no token (403): only the pane\'s workspace token asks', async () => {
    const { getCliToken } = await import('@/lib/cli-token');
    const { ensureTabToken } = await import('@/lib/tab-token');
    const tabToken = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-new' }, 'pt-ws-a-pane-1-tab-new');
    for (const token of [getCliToken(), tabToken, null, 'not-a-token']) {
      expect((await post(token, { session: 'pt-ws-a-pane-1-tab-old' })).status).toBe(403);
    }
  });

  it('answers 404 for a session of another workspace, an unknown session or a browser tab; 400 for a malformed one', async () => {
    const token = await wsToken('ws-a');
    expect((await post(token, { session: 'pt-ws-b-pane-1-tab-b1' })).status).toBe(404);
    expect((await post(token, { session: 'pt-ws-a-pane-1-tab-nope' })).status).toBe(404);
    expect((await post(token, { session: 'pt-ws-a-pane-1-tab-web' })).status).toBe(404);
    for (const session of [undefined, '', 'a b', 'x'.repeat(201), '"; rm -rf /']) {
      expect((await post(token, { session })).status).toBe(400);
    }
    expect((await post(token, { session: 'pt-ws-a-pane-1-tab-old' }, 'GET')).status).toBe(405);
  });

  it('the ruling\'s disproof test: another tab with the workspace token gets the same token, which is why it is never verified', async () => {
    const token = await wsToken('ws-a');
    const byHook = await post(token, { session: 'pt-ws-a-pane-1-tab-old' });
    const bySibling = await post(token, { session: 'pt-ws-a-pane-1-tab-old' });
    expect(bySibling.body.token).toBe(byHook.body.token);
    const { resolveCaller } = await import('@/lib/caller');
    const caller = await resolveCaller({ headers: { 'x-pmux-token': String(byHook.body.token) }, query: {} } as unknown as NextApiRequest);
    expect(caller).toMatchObject({ tabId: 'tab-old', verified: false, identity: 'hook' });
  });
});
