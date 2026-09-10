import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const layout = vi.hoisted(() => ({
  addTabToPane: vi.fn(),
  getLayout: vi.fn(),
}));
const codex = vi.hoisted(() => ({ buildLaunchCommand: vi.fn() }));
const dispatch = vi.hoisted(() => ({ checkAgentDispatchPolicy: vi.fn() }));
const managed = vi.hoisted(() => ({
  prepareCodexManagedLaunch: vi.fn(),
  submitCodexManagedLaunch: vi.fn(),
  waitForCodexManagedLaunch: vi.fn(),
}));

vi.mock('@/lib/layout-store', () => ({
  addTabToPane: layout.addTabToPane,
  getLayout: layout.getLayout,
  isAgentPanelType: (panelType?: string) => panelType === 'codex-cli',
}));
vi.mock('@/lib/layout-tree', () => ({ collectPanes: vi.fn(() => []) }));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: vi.fn(async () => ({ id: 'ws-pins', directories: ['/repo'] })),
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
}));
vi.mock('@/lib/cli-utils', () => ({
  authorizeWorkspace: vi.fn(async () => ({ type: 'workspace', workspaceId: 'ws-pins' })),
  canAccessWorkspace: vi.fn(async () => true),
  resolveFirstPaneId: vi.fn(async () => 'pane-one'),
}));
vi.mock('@/lib/workspace-token', () => ({
  resolveCliScope: vi.fn(() => ({ type: 'workspace', workspaceId: 'ws-pins' })),
}));
vi.mock('@/lib/providers', () => ({ getProviderByPanelType: vi.fn(() => ({ id: 'codex', readSessionId: () => null })) }));
vi.mock('@/lib/agent-availability', () => ({
  checkAgentAvailabilityForPanelType: vi.fn(async () => ({ ok: true })),
  toAgentAvailabilityError: vi.fn(),
}));
vi.mock('@/lib/agent-effort', () => ({
  isValidReasoningForPanelType: vi.fn(() => true),
  reasoningErrorForPanelType: vi.fn(() => 'Invalid reasoning'),
}));
vi.mock('@/lib/claude-command', () => ({
  buildClaudeFlags: vi.fn(),
  isValidModelName: vi.fn(() => true),
}));
vi.mock('@/lib/providers/codex', () => ({ codexProvider: codex }));
vi.mock('@/lib/providers/grok', () => ({ grokProvider: { buildLaunchCommand: vi.fn() } }));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ registerTab: vi.fn(), markAgentLaunch: vi.fn() }),
}));
vi.mock('@/lib/agent-dispatch-policy', () => dispatch);
vi.mock('@/lib/providers/codex/managed-launch', () => managed);

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
  const state = { statusCode: 0, body: undefined, res: undefined } as unknown as IFakeResponse;
  state.res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return state;
};

describe('POST /api/cli/tabs launch config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatch.checkAgentDispatchPolicy.mockResolvedValue({ ok: true });
    codex.buildLaunchCommand.mockResolvedValue('codex-command');
    managed.prepareCodexManagedLaunch.mockResolvedValue({
      ok: true,
      launch: { generation: 'codex-generation' },
    });
    managed.submitCodexManagedLaunch.mockResolvedValue({
      ok: true,
      generation: 'codex-generation',
      phase: 'submitted',
    });
    managed.waitForCodexManagedLaunch.mockResolvedValue({
      ok: true,
      generation: 'codex-generation',
      phase: 'active',
    });
    layout.addTabToPane.mockResolvedValue({
      id: 'tab-new',
      sessionName: 'pt-ws-pins-pane-one-tab-new',
      name: 'worker',
      order: 1,
      panelType: 'codex-cli',
    });
  });

  it('persists only the explicitly requested model and effort on the created tab', async () => {
    const { default: handler } = await import('@/pages/api/cli/tabs');
    const response = fakeResponse();

    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'workspace-token' },
      body: {
        workspaceId: 'ws-pins',
        panelType: 'codex-cli',
        model: 'gpt-5.6-sol',
        reasoning: 'high',
      },
    } as unknown as NextApiRequest, response.res);

    expect(dispatch.checkAgentDispatchPolicy).toHaveBeenCalledWith('ws-pins');
    expect(layout.addTabToPane).toHaveBeenCalledWith(
      'ws-pins',
      'pane-one',
      undefined,
      '/repo',
      'codex-cli',
      undefined,
      {
        scope: undefined,
        agentLaunchConfig: { model: 'gpt-5.6-sol', effort: 'high' },
      },
    );
    expect(managed.prepareCodexManagedLaunch).toHaveBeenCalledWith('ws-pins', 'tab-new');
    expect(managed.submitCodexManagedLaunch).toHaveBeenCalledWith(
      'ws-pins', 'tab-new', 'codex-generation',
    );
    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({ launched: true, launchState: 'active' });
  });

  it('does not invent launch config for an unpinned tab', async () => {
    const { default: handler } = await import('@/pages/api/cli/tabs');
    const response = fakeResponse();

    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'workspace-token' },
      body: { workspaceId: 'ws-pins', panelType: 'codex-cli' },
    } as unknown as NextApiRequest, response.res);

    expect(layout.addTabToPane.mock.calls[0][6]).toEqual({
      scope: undefined,
      agentLaunchConfig: undefined,
    });
  });

  it('returns the dispatch mismatch before building or creating the tab', async () => {
    dispatch.checkAgentDispatchPolicy.mockResolvedValue({
      ok: false,
      error: 'agent-model-mismatch',
      tabId: 'tab-orchestrator',
    });
    const { default: handler } = await import('@/pages/api/cli/tabs');
    const response = fakeResponse();

    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'workspace-token' },
      body: { workspaceId: 'ws-pins', panelType: 'codex-cli' },
    } as unknown as NextApiRequest, response.res);

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ error: 'agent-model-mismatch', tabId: 'tab-orchestrator' });
    expect(codex.buildLaunchCommand).not.toHaveBeenCalled();
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });
});
