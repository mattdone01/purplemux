import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The authorization refusals and the api-guide scope, with the real
// cli-utils module: only the token resolver and the stores are faked.

const scope = vi.hoisted(() => ({
  resolveCliScope: vi.fn((): { type: 'admin' } | { type: 'workspace'; workspaceId: string } | null => null),
}));
const stores = vi.hoisted(() => ({
  getWorkspaceById: vi.fn(async (): Promise<{ id: string; allowedPeers?: string[] } | null> => ({ id: 'ws-1' })),
  getLayout: vi.fn(async () => ({ root: { type: 'pane', id: 'pane-1', tabs: [] } })),
}));

vi.mock('@/lib/workspace-token', () => scope);
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: stores.getWorkspaceById }));
vi.mock('@/lib/layout-store', () => ({ getLayout: stores.getLayout }));
vi.mock('@/lib/layout-tree', () => ({
  collectPanes: (root: { tabs: unknown[]; id: string }) => [root],
  getFirstPaneId: () => 'pane-1',
}));
vi.mock('@/lib/browser-bridge-client', () => ({ getBrowserBridge: () => null }));

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
  const state = { statusCode: 0, body: undefined, res: undefined } as unknown as IFakeResponse;
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
    send(body: unknown) {
      state.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
  } as unknown as NextApiResponse;
  return state;
};

const request = (query: Record<string, string> = {}, method = 'GET') =>
  ({ method, query, headers: { 'x-pmux-token': 'any' } }) as unknown as NextApiRequest;

beforeEach(() => {
  vi.clearAllMocks();
  scope.resolveCliScope.mockReturnValue(null);
});

describe('authorization refusals carry code forbidden (exit 3)', () => {
  it('authorizeWorkspace refuses an unknown token', async () => {
    const { authorizeWorkspace } = await import('@/lib/cli-utils');
    const response = fakeResponse();

    expect(await authorizeWorkspace(request(), response.res, 'ws-1')).toBeNull();
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: 'Forbidden', code: 'forbidden' });
  });

  it('authorizeWorkspace refuses a workspace out of scope and keeps its explanation', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-other' });
    const { authorizeWorkspace } = await import('@/lib/cli-utils');
    const response = fakeResponse();

    expect(await authorizeWorkspace(request(), response.res, 'ws-1')).toBeNull();
    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: 'forbidden', error: expect.stringContaining('allowedPeers') });
  });

  it('authorizeWorkspaceInput refuses an unknown token', async () => {
    const { authorizeWorkspaceInput } = await import('@/lib/cli-utils');
    const response = fakeResponse();

    expect(await authorizeWorkspaceInput(request(), response.res, 'ws-1')).toBeNull();
    expect(response.body).toEqual({ error: 'Forbidden', code: 'forbidden' });
  });

  it('authorizeWorkspaceInput refuses the global token and keeps its explanation', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'admin' });
    const { authorizeWorkspaceInput } = await import('@/lib/cli-utils');
    const response = fakeResponse();

    expect(await authorizeWorkspaceInput(request(), response.res, 'ws-1')).toBeNull();
    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: 'forbidden', error: expect.stringContaining('PMUX_TOKEN') });
  });

  it('withBrowserTab answers a missing tab with tab-not-found', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-1' });
    const { withBrowserTab } = await import('@/lib/cli-utils');
    const response = fakeResponse();
    const handler = vi.fn();

    await withBrowserTab(request({ tabId: 'tab-x', workspaceId: 'ws-1' }), response.res, 'GET', handler);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'Tab not found', code: 'tab-not-found' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('GET /api/cli/api-guide', () => {
  it('serves the guide to a workspace-scoped token — the token an agent tab holds', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-1' });
    const { default: handler } = await import('@/pages/api/cli/api-guide');
    const response = fakeResponse();

    await handler(request(), response.res);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('# purplemux CLI HTTP API');
    expect(response.body).toContain('## Errors and exit codes');
  });

  it('serves the guide to the global token', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'admin' });
    const { default: handler } = await import('@/pages/api/cli/api-guide');
    const response = fakeResponse();

    await handler(request(), response.res);

    expect(response.statusCode).toBe(200);
  });

  it('refuses a token that resolves to no scope', async () => {
    const { default: handler } = await import('@/pages/api/cli/api-guide');
    const response = fakeResponse();

    await handler(request(), response.res);

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: 'Forbidden', code: 'forbidden' });
  });

  it('lists every exit code in the guide', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'admin' });
    const { default: handler } = await import('@/pages/api/cli/api-guide');
    const response = fakeResponse();

    await handler(request(), response.res);

    const guide = response.body as string;
    const section = guide.slice(guide.indexOf('## Errors and exit codes'), guide.indexOf('## Workspaces'));
    for (const exit of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(section).toMatch(new RegExp(`^\\s+${exit}\\s`, 'm'));
    }
  });
});
