import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITab } from '@/types/terminal';

const cli = vi.hoisted(() => ({
  authorizeWorkspace: vi.fn(),
  authorizeWorkspaceInput: vi.fn(),
  findTab: vi.fn(),
}));
const layout = vi.hoisted(() => ({
  removeTabFromPane: vi.fn(),
  updateTabAgentLaunchConfig: vi.fn(),
  setTabReportsTo: vi.fn(async () => true),
}));
const tmux = vi.hoisted(() => ({ hasSession: vi.fn(async () => true) }));
const liveness = vi.hoisted(() => ({ registerJob: vi.fn(async (_job: { pid: number; notify?: string }) => {}) }));

vi.mock('@/lib/cli-utils', () => cli);
vi.mock('@/lib/layout-store', () => layout);
vi.mock('@/lib/tmux', () => tmux);
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => liveness }));
vi.mock('@/lib/providers', () => ({ getProviderByPanelType: () => ({ id: 'claude', readSessionId: () => null }) }));

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const tab = (id: string, extra: Partial<ITab> = {}): ITab => ({
  id, name: id, order: 0, sessionName: `pt-ws-1-pane-a-${id}`, panelType: 'claude-code', ...extra,
});

const tabsIn: Record<string, string[]> = { 'ws-1': ['tab-w', 'tab-o', 'tab-web'], 'ws-2': ['tab-x'] };

describe('reportsTo on the tab routes (ADR-0018)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cli.authorizeWorkspaceInput.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-1' });
    cli.authorizeWorkspace.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-1' });
    cli.findTab.mockImplementation(async (ws: string, id: string) =>
      tabsIn[ws]?.includes(id)
        ? { workspaceId: ws, paneId: 'pane-a', tab: tab(id, id === 'tab-web' ? { panelType: 'web-browser' } : {}) }
        : null);
    tmux.hasSession.mockResolvedValue(true);
  });

  const patch = async (body: unknown) => {
    const { state, res } = fakeResponse();
    const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]');
    await handler({ method: 'PATCH', query: { workspaceId: 'ws-1', tabId: 'tab-w' }, body } as unknown as NextApiRequest, res);
    return state;
  };

  it('sets and clears reportsTo with input-grade authorization', async () => {
    expect(await patch({ reportsTo: 'tab-o' })).toEqual({ statusCode: 200, body: { tabId: 'tab-w', workspaceId: 'ws-1', reportsTo: 'tab-o' } });
    expect(await patch({ reportsTo: null })).toEqual({ statusCode: 200, body: { tabId: 'tab-w', workspaceId: 'ws-1', reportsTo: null } });
    expect(layout.setTabReportsTo.mock.calls).toEqual([['ws-1', 'tab-w', 'tab-o'], ['ws-1', 'tab-w', null]]);
    expect(cli.authorizeWorkspaceInput).toHaveBeenCalled();
  });

  it.each([
    ['a tab of another workspace', 'tab-x'],
    ['an unknown tab', 'tab-nope'],
    ['itself', 'tab-w'],
    ['a browser tab', 'tab-web'],
    ['an empty id', ''],
    ['a non-string', 7],
  ])('refuses %s with reports-to-invalid', async (_label, reportsTo) => {
    const state = await patch({ reportsTo });
    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ code: 'reports-to-invalid' });
    expect(layout.setTabReportsTo).not.toHaveBeenCalled();
  });

  it('refuses a tab whose session is dead', async () => {
    tmux.hasSession.mockResolvedValue(false);
    expect((await patch({ reportsTo: 'tab-o' })).body).toMatchObject({ code: 'reports-to-invalid' });
  });

  it('refuses reportsTo mixed with other fields', async () => {
    expect((await patch({ reportsTo: 'tab-o', agentLaunchConfig: null })).statusCode).toBe(400);
  });

  it('shows reportsTo on GET', async () => {
    cli.findTab.mockResolvedValue({ workspaceId: 'ws-1', paneId: 'pane-a', tab: tab('tab-w', { reportsTo: 'tab-o' }) });
    const { state, res } = fakeResponse();
    const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]');
    await handler({ method: 'GET', query: { workspaceId: 'ws-1', tabId: 'tab-w' } } as unknown as NextApiRequest, res);
    expect(state.body).toMatchObject({ reportsTo: 'tab-o' });
  });

  describe('POST /bg notify', () => {
    const post = async (body: unknown) => {
      const { state, res } = fakeResponse();
      const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/bg');
      await handler({ method: 'POST', query: { workspaceId: 'ws-1', tabId: 'tab-w' }, body } as unknown as NextApiRequest, res);
      return state;
    };

    it('stores notify self and omits the default', async () => {
      expect((await post({ pid: 42, notify: 'self' })).statusCode).toBe(200);
      expect((await post({ pid: 43, notify: 'orchestrator' })).statusCode).toBe(200);
      expect((await post({ pid: 44 })).statusCode).toBe(200);
      const jobs = liveness.registerJob.mock.calls.map(([job]) => job);
      expect(jobs.map((j) => [j.pid, j.notify])).toEqual([[42, 'self'], [43, undefined], [44, undefined]]);
    });

    it('refuses an unknown notify value', async () => {
      expect((await post({ pid: 42, notify: 'everyone' })).statusCode).toBe(400);
      expect(liveness.registerJob).not.toHaveBeenCalled();
    });
  });
});
