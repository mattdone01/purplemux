import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cliUtils = vi.hoisted(() => ({
  authorizeWorkspace: vi.fn(),
  findTab: vi.fn(),
}));
const tmux = vi.hoisted(() => ({
  hasSession: vi.fn(),
  getPaneCurrentCommand: vi.fn(),
}));
const modelObservation = vi.hoisted(() => ({ getCodexModelStatus: vi.fn() }));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn() }));

vi.mock('@/lib/cli-utils', () => cliUtils);
vi.mock('@/lib/tmux', () => tmux);
vi.mock('@/lib/providers/codex/model-observation', () => modelObservation);
vi.mock('@/lib/providers', () => ({
  getProviderByPanelType: () => ({
    id: 'codex',
    readSessionId: () => '11111111-1111-4111-8111-111111111111',
  }),
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => liveness }));

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  res: NextApiResponse;
}

const response = (): IFakeResponse => {
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
    setHeader() {
      return this;
    },
  } as unknown as NextApiResponse;
  return state;
};

const tab = {
  id: 'tab-1',
  sessionName: 'pmux-tab-1',
  name: 'worker',
  order: 0,
  panelType: 'codex-cli',
  agentLaunchConfig: { model: 'gpt-6-astra', effort: 'high' },
};

describe('GET /api/cli/tabs/[tabId]/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliUtils.authorizeWorkspace.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-1' });
    cliUtils.findTab.mockResolvedValue({ workspaceId: 'ws-1', paneId: 'pane-1', tab });
    tmux.hasSession.mockResolvedValue(true);
    tmux.getPaneCurrentCommand.mockResolvedValue('codex');
    modelObservation.getCodexModelStatus.mockResolvedValue({
      expected: { model: 'gpt-6-astra', effort: 'high' },
      observed: {
        model: 'gpt-5.6-luna',
        effort: 'medium',
        source: 'thread_settings_applied',
        timestamp: '2026-09-10T10:00:00.000Z',
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
      latestTurn: null,
      latestSettings: null,
      status: 'mismatch',
    });
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });

  it('authorizes and locates the tab before exposing its model observation', async () => {
    const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/status');
    const res = response();

    await handler({
      method: 'GET',
      query: { workspaceId: 'ws-1', tabId: 'tab-1' },
    } as unknown as NextApiRequest, res.res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      tabId: 'tab-1',
      alive: true,
      modelStatus: {
        expected: { model: 'gpt-6-astra', effort: 'high' },
        observed: { model: 'gpt-5.6-luna', effort: 'medium' },
        status: 'mismatch',
      },
    });
    expect(cliUtils.authorizeWorkspace.mock.invocationCallOrder[0])
      .toBeLessThan(cliUtils.findTab.mock.invocationCallOrder[0]);
    expect(cliUtils.findTab.mock.invocationCallOrder[0])
      .toBeLessThan(modelObservation.getCodexModelStatus.mock.invocationCallOrder[0]);
    expect(JSON.stringify(res.body)).not.toContain('.jsonl');
  });

  it('does not inspect the tab or its session when authorization fails', async () => {
    cliUtils.authorizeWorkspace.mockResolvedValue(null);
    const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/status');
    const res = response();

    await handler({
      method: 'GET',
      query: { workspaceId: 'ws-1', tabId: 'tab-1' },
    } as unknown as NextApiRequest, res.res);

    expect(cliUtils.findTab).not.toHaveBeenCalled();
    expect(modelObservation.getCodexModelStatus).not.toHaveBeenCalled();
  });

  it('marks a dead tab unavailable instead of reusing historical model evidence', async () => {
    tmux.hasSession.mockResolvedValue(false);
    modelObservation.getCodexModelStatus.mockResolvedValue({
      expected: { model: 'gpt-6-astra', effort: 'high' },
      observed: null,
      latestTurn: null,
      latestSettings: null,
      scanState: 'unavailable',
      hasActivity: false,
      status: 'unknown',
      reason: 'runtime-unavailable',
    });
    const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/status');
    const res = response();

    await handler({
      method: 'GET',
      query: { workspaceId: 'ws-1', tabId: 'tab-1' },
    } as unknown as NextApiRequest, res.res);

    expect(modelObservation.getCodexModelStatus).toHaveBeenCalledWith(tab, { runtimeAlive: false });
    expect(res.body).toMatchObject({
      alive: false,
      modelStatus: { status: 'unknown', reason: 'runtime-unavailable' },
    });
  });
});
