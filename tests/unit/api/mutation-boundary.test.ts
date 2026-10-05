import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ token: 'foreign', granted: false }));
vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: () => state.token === 'global'
  ? { type: 'admin' } : state.token === 'human' ? null
    : { type: 'workspace', workspaceId: state.token === 'local' ? 'ws-target' : 'ws-foreign', tabId: 'tab-caller', tabVerified: true } }));
vi.mock('@/lib/auth', async (original) => ({ ...await original<typeof import('@/lib/auth')>(),
  verifySessionToken: vi.fn(async (token: string) => token === 'human' ? { sub: 'human' } : null),
}));
vi.mock('@/lib/grant-store', () => ({ grantsSnapshot: vi.fn(() => ({})), findActiveDriveGrant: vi.fn(() => state.granted ? { id: 'g-active' } : null) }));
vi.mock('@/lib/workspace-store');
vi.mock('@/lib/layout-store');
vi.mock('@/lib/tmux');
vi.mock('@/lib/status-manager');
vi.mock('@/lib/providers/codex/managed-launch');
vi.mock('@/lib/providers/codex/launch-lifecycle');
vi.mock('@/lib/liveness-manager');

const response = () => {
  const state = { code: 0, body: undefined as unknown };
  const res = { status(code: number) { state.code = code; return this; }, json(body: unknown) { state.body = body; return this; }, setHeader() {} } as unknown as NextApiResponse;
  return { state, res };
};

const cliRoutes = [
  ['cli/tabs/index', 'POST'], ['cli/tabs/[tabId]/index', 'DELETE'], ['cli/tabs/[tabId]/index', 'PATCH'],
  ['cli/tabs/[tabId]/send', 'POST'], ['cli/tabs/[tabId]/steer', 'POST'],
  ['cli/tabs/[tabId]/probe', 'POST'], ['cli/tabs/[tabId]/probe', 'DELETE'],
  ['cli/tabs/[tabId]/bg', 'POST'], ['cli/tabs/[tabId]/bg', 'DELETE'],
  ['cli/tabs/[tabId]/browser/eval', 'POST'],
  ['cli/workspaces/[workspaceId]/directories', 'PATCH'], ['cli/workspaces/[workspaceId]/orchestration', 'PATCH'],
  ['cli/workspaces/[workspaceId]/standup', 'POST'],
  ['codex/launch-command', 'POST'], ['codex/launch-submit', 'POST'], ['codex/launch-args', 'POST'],
  ['codex/launch-confirm', 'POST'], ['claude/launch-command', 'POST'],
  ['cli/codex/launch-args', 'POST'], ['cli/codex/launch-confirm', 'POST'],
];
const uiRoutes = [
  ['tabs/[tabId]/send', 'POST'], ['tmux/send-input', 'POST'], ['tmux/reset', 'POST'], ['tmux/recover-unknown', 'POST'],
  ['status/agent-launch', 'POST'], ['layout/index', 'PATCH'], ['layout/pane/index', 'POST'],
  ['layout/pane/[paneId]/index', 'DELETE'], ['layout/pane/[paneId]/index', 'PATCH'],
  ['layout/pane/[paneId]/tabs/index', 'POST'], ['layout/pane/[paneId]/tabs/order', 'PATCH'],
  ['layout/pane/[paneId]/tabs/[tabId]/index', 'POST'], ['layout/pane/[paneId]/tabs/[tabId]/index', 'PATCH'],
  ['layout/pane/[paneId]/tabs/[tabId]/index', 'DELETE'], ['layout/pane/[paneId]/tabs/[tabId]/move', 'POST'],
  ['workspace/index', 'POST'], ['workspace/[workspaceId]', 'PATCH'], ['workspace/[workspaceId]', 'DELETE'],
  ['workspace/[workspaceId]/orchestrate', 'POST'], ['workspace/active', 'PATCH'], ['workspace/reorder', 'PATCH'],
  ['workspace/group/index', 'POST'], ['workspace/group/[groupId]', 'PATCH'], ['workspace/group/[groupId]', 'DELETE'],
  ['workspace/group/reorder', 'PATCH'], ['cli/workspaces/[workspaceId]/peers', 'PATCH'],
];

const handlers: Record<string, () => Promise<{ default: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown> }>> = {
  'claude/launch-command': () => import('@/pages/api/claude/launch-command'),
  'cli/codex/launch-args': () => import('@/pages/api/cli/codex/launch-args'),
  'cli/codex/launch-confirm': () => import('@/pages/api/cli/codex/launch-confirm'),
  'cli/tabs/[tabId]/bg': () => import('@/pages/api/cli/tabs/[tabId]/bg'),
  'cli/tabs/[tabId]/browser/eval': () => import('@/pages/api/cli/tabs/[tabId]/browser/eval'),
  'cli/tabs/[tabId]/index': () => import('@/pages/api/cli/tabs/[tabId]/index'),
  'cli/tabs/[tabId]/probe': () => import('@/pages/api/cli/tabs/[tabId]/probe'),
  'cli/tabs/[tabId]/send': () => import('@/pages/api/cli/tabs/[tabId]/send'),
  'cli/tabs/[tabId]/steer': () => import('@/pages/api/cli/tabs/[tabId]/steer'),
  'cli/tabs/index': () => import('@/pages/api/cli/tabs/index'),
  'cli/workspaces/[workspaceId]/directories': () => import('@/pages/api/cli/workspaces/[workspaceId]/directories'),
  'cli/workspaces/[workspaceId]/orchestration': () => import('@/pages/api/cli/workspaces/[workspaceId]/orchestration'),
  'cli/workspaces/[workspaceId]/peers': () => import('@/pages/api/cli/workspaces/[workspaceId]/peers'),
  'cli/workspaces/[workspaceId]/standup': () => import('@/pages/api/cli/workspaces/[workspaceId]/standup'),
  'codex/launch-args': () => import('@/pages/api/codex/launch-args'),
  'codex/launch-command': () => import('@/pages/api/codex/launch-command'),
  'codex/launch-confirm': () => import('@/pages/api/codex/launch-confirm'),
  'codex/launch-submit': () => import('@/pages/api/codex/launch-submit'),
  'layout/index': () => import('@/pages/api/layout/index'),
  'layout/pane/[paneId]/index': () => import('@/pages/api/layout/pane/[paneId]/index'),
  'layout/pane/[paneId]/tabs/[tabId]/index': () => import('@/pages/api/layout/pane/[paneId]/tabs/[tabId]/index'),
  'layout/pane/[paneId]/tabs/[tabId]/move': () => import('@/pages/api/layout/pane/[paneId]/tabs/[tabId]/move'),
  'layout/pane/[paneId]/tabs/index': () => import('@/pages/api/layout/pane/[paneId]/tabs/index'),
  'layout/pane/[paneId]/tabs/order': () => import('@/pages/api/layout/pane/[paneId]/tabs/order'),
  'layout/pane/index': () => import('@/pages/api/layout/pane/index'),
  'status/agent-launch': () => import('@/pages/api/status/agent-launch'),
  'tabs/[tabId]/send': () => import('@/pages/api/tabs/[tabId]/send'),
  'tmux/recover-unknown': () => import('@/pages/api/tmux/recover-unknown'),
  'tmux/reset': () => import('@/pages/api/tmux/reset'),
  'tmux/send-input': () => import('@/pages/api/tmux/send-input'),
  'workspace/[workspaceId]': () => import('@/pages/api/workspace/[workspaceId]'),
  'workspace/[workspaceId]/orchestrate': () => import('@/pages/api/workspace/[workspaceId]/orchestrate'),
  'workspace/active': () => import('@/pages/api/workspace/active'),
  'workspace/group/[groupId]': () => import('@/pages/api/workspace/group/[groupId]'),
  'workspace/group/index': () => import('@/pages/api/workspace/group/index'),
  'workspace/group/reorder': () => import('@/pages/api/workspace/group/reorder'),
  'workspace/index': () => import('@/pages/api/workspace/index'),
  'workspace/reorder': () => import('@/pages/api/workspace/reorder'),
};

const request = (method: string, cookie = false, origin = 'http://localhost:8022') => ({
  method, headers: { ...(cookie ? { cookie: 'session-token=human' } : { 'x-pmux-token': state.token }), host: 'localhost:8022', origin },
  query: { workspaceId: 'ws-target', tabId: 'tab-target', paneId: 'pane-target' },
  body: { workspaceId: 'ws-target', tabId: 'tab-target', generation: 'generation', sessionName: 'session', launcherPid: 1001, childPid: 1002 },
  socket: { remoteAddress: '127.0.0.1' },
} as unknown as NextApiRequest);

const runtimeModules = async () => Promise.all([
  import('@/lib/workspace-store'), import('@/lib/layout-store'), import('@/lib/tmux'),
  import('@/lib/liveness-manager'), import('@/lib/status-manager'), import('@/lib/providers/codex/managed-launch'), import('@/lib/providers/codex/launch-lifecycle'),
]);

describe('route mutation authority matrix', () => {
  beforeEach(async () => {
    vi.clearAllMocks(); state.granted = false;
    for (const runtime of await runtimeModules()) for (const value of Object.values(runtime)) {
      if (vi.isMockFunction(value)) value.mockReset();
    }
  });
  for (const token of ['foreign', 'grant', 'global']) {
    it.each(cliRoutes)(`${token} cannot mutate %s %s`, async (route, method) => {
      state.token = token; state.granted = token === 'grant';
      const { default: handler } = await handlers[route]();
      const { state: result, res } = response();
      await handler(request(method), res);
      expect(result.code).toBe(403);
      for (const runtime of await runtimeModules()) for (const value of Object.values(runtime)) {
        if (vi.isMockFunction(value)) expect(value).not.toHaveBeenCalled();
      }
    });
  }
  for (const token of ['local', 'foreign', 'grant', 'global']) {
    it.each(uiRoutes)(`${token} is not a human at %s %s`, async (route, method) => {
      state.token = token; state.granted = token === 'grant';
      const { default: handler } = await handlers[route]();
      const { state: result, res } = response();
      await handler(request(method), res);
      expect(result.code).toBe(401);
      for (const runtime of await runtimeModules()) for (const value of Object.values(runtime)) {
        if (vi.isMockFunction(value)) expect(value).not.toHaveBeenCalled();
      }
    });
  }
  it.each(uiRoutes)('cross-origin human cannot mutate %s %s', async (route, method) => {
    const { default: handler } = await handlers[route]();
    const { state: result, res } = response();
    await handler(request(method, true, 'http://elsewhere'), res);
    expect(result.code).toBe(403);
  });
  for (const [actor, routes] of [['local', cliRoutes], ['human', uiRoutes]] as const) {
    it.each(routes)(`${actor} passes the mutation boundary at %s %s`, async (route, method) => {
      state.token = actor;
      const { default: handler } = await handlers[route]();
      const reachedRuntime = new Error('authorized runtime reached');
      for (const runtime of await runtimeModules()) for (const value of Object.values(runtime)) {
        if (vi.isMockFunction(value)) value.mockImplementation(() => { throw reachedRuntime; });
      }
      const { state: result, res } = response();
      try {
        await handler(request(method, actor === 'human'), res);
        expect(result.code).not.toBe(401);
        expect(result.code).not.toBe(403);
        expect(result.code).not.toBe(0);
      } catch (error) {
        expect(error).toBe(reachedRuntime);
      }
    });
  }
  it.each(['codex/launch-command', 'codex/launch-submit', 'claude/launch-command'])(
    '%s authenticates its cookie branch even without the proxy', async (route) => {
      const { default: handler } = await handlers[route]();
      const unauthenticated = request('POST');
      delete unauthenticated.headers['x-pmux-token'];
      const denied = response();
      await handler(unauthenticated, denied.res);
      expect(denied.state.code).toBe(401);
      const crossOrigin = response();
      await handler(request('POST', true, 'http://elsewhere'), crossOrigin.res);
      expect(crossOrigin.state.code).toBe(403);
      for (const runtime of await runtimeModules()) for (const value of Object.values(runtime)) {
        if (vi.isMockFunction(value)) expect(value).not.toHaveBeenCalled();
      }
    },
  );
  it('retains legacy local workspace mutation authority and authenticates human origin', async () => {
    const { authorizeWorkspace } = await import('@/lib/cli-utils');
    const { authorizeHumanMutation } = await import('@/lib/human-mutation');
    state.token = 'local';
    expect(await authorizeWorkspace(request('POST'), response().res, 'ws-target')).toMatchObject({ workspaceId: 'ws-target' });
    expect(await authorizeHumanMutation(request('POST', true), response().res)).toBe(true);
  });
});
