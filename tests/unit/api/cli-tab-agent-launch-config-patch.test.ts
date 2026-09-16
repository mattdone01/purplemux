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
}));

vi.mock('@/lib/cli-utils', () => cli);
vi.mock('@/lib/layout-store', () => layout);
vi.mock('@/lib/providers', () => ({
  getProviderByPanelType: (panelType?: string) => panelType === 'codex-cli' ? { id: 'codex' } : null,
}));

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
  const state = { statusCode: 0, body: undefined, headers: {}, res: undefined } as unknown as IFakeResponse;
  state.res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader(name: string, value: string) { state.headers[name] = value; return this; },
  } as unknown as NextApiResponse;
  return state;
};

const tab: ITab = {
  id: 'tab-pins',
  sessionName: 'pt-ws-pins-pane-one-tab-pins',
  name: 'worker',
  order: 0,
  panelType: 'codex-cli',
};

describe('PATCH /api/cli/tabs/[tabId] agentLaunchConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cli.authorizeWorkspaceInput.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-pins' });
    cli.findTab.mockResolvedValue({ workspaceId: 'ws-pins', paneId: 'pane-one', tab });
    layout.updateTabAgentLaunchConfig.mockImplementation(async (_wsId, _paneId, _tabId, config) => ({
      ...tab,
      ...(config ? { agentLaunchConfig: config } : {}),
    }));
  });

  const call = async (agentLaunchConfig: unknown): Promise<IFakeResponse> => {
    const response = fakeResponse();
    const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]');
    await handler({
      method: 'PATCH',
      query: { workspaceId: 'ws-pins', tabId: 'tab-pins' },
      body: { agentLaunchConfig },
    } as unknown as NextApiRequest, response.res);
    return response;
  };

  it('uses input-grade workspace authorization and stores future launch pins', async () => {
    const response = await call({ model: 'gpt-6-astra', effort: 'high' });

    expect(cli.authorizeWorkspaceInput).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ws-pins');
    expect(cli.authorizeWorkspace).not.toHaveBeenCalled();
    expect(layout.updateTabAgentLaunchConfig).toHaveBeenCalledWith(
      'ws-pins',
      'pane-one',
      'tab-pins',
      { model: 'gpt-6-astra', effort: 'high' },
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      tabId: 'tab-pins',
      workspaceId: 'ws-pins',
      agentLaunchConfig: { model: 'gpt-6-astra', effort: 'high' },
      appliesTo: 'future-launches',
      runningProcessChanged: false,
    });
  });

  it.each([
    [{ model: 'bad model' }, 'Invalid model'],
    [{ effort: 'ultra' }, 'Invalid reasoning for codex-cli (minimal|low|medium|high)'],
    [{ model: 'gpt-6-astra', extra: true }, 'agentLaunchConfig supports only model and effort'],
  ])('rejects invalid config %j', async (agentLaunchConfig, error) => {
    const response = await call(agentLaunchConfig);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error });
    expect(layout.updateTabAgentLaunchConfig).not.toHaveBeenCalled();
  });

  it('clears the stored policy explicitly without changing the running process', async () => {
    const response = await call(null);

    expect(layout.updateTabAgentLaunchConfig).toHaveBeenCalledWith(
      'ws-pins',
      'pane-one',
      'tab-pins',
      null,
    );
    expect(response.body).toMatchObject({
      agentLaunchConfig: null,
      appliesTo: 'future-launches',
      runningProcessChanged: false,
    });
  });
});
