import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const layout = vi.hoisted(() => ({ addTabToPane: vi.fn() }));
const claude = vi.hoisted(() => ({ buildClaudeFlags: vi.fn() }));
const workspace = vi.hoisted(() => ({ updateWorkspaceOrchestration: vi.fn() }));
const manager = vi.hoisted(() => ({
  registerTab: vi.fn(),
  markAgentLaunch: vi.fn(),
  queueKickoffPrompt: vi.fn(),
}));

vi.mock('@/lib/layout-store', () => layout);
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: vi.fn(async () => ({ id: 'ws-pins', directories: ['/repo'] })),
  updateWorkspaceOrchestration: workspace.updateWorkspaceOrchestration,
}));
vi.mock('@/lib/cli-utils', () => ({ resolveFirstPaneId: vi.fn(async () => 'pane-one') }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => manager }));
vi.mock('@/lib/providers', () => ({
  getProviderByPanelType: vi.fn(() => ({ id: 'claude', readSessionId: () => null })),
}));
vi.mock('@/lib/agent-availability', () => ({
  checkAgentAvailabilityForPanelType: vi.fn(async () => ({ ok: true })),
  toAgentAvailabilityError: vi.fn(),
}));
vi.mock('@/lib/claude-command', () => ({
  buildClaudeFlags: claude.buildClaudeFlags,
  isValidClaudeEffort: vi.fn(() => true),
  isValidModelName: vi.fn(() => true),
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

describe('POST /api/workspace/[workspaceId]/orchestrate launch config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claude.buildClaudeFlags.mockResolvedValue('--model claude-opus-5 --effort high');
    layout.addTabToPane.mockResolvedValue({
      id: 'tab-root',
      sessionName: 'pt-ws-pins-pane-one-tab-root',
      name: 'orchestrator',
      order: 0,
      panelType: 'claude-code',
      agentLaunchConfig: { model: 'claude-opus-5', effort: 'high' },
    });
  });

  it('persists the same explicit pins used to launch the orchestrator', async () => {
    const { default: handler } = await import('@/pages/api/workspace/[workspaceId]/orchestrate');
    const { state, res } = fakeResponse();

    await handler({
      method: 'POST',
      query: { workspaceId: 'ws-pins' },
      body: {
        prompt: 'Run the epic',
        model: 'claude-opus-5',
        effort: 'high',
      },
    } as unknown as NextApiRequest, res);

    expect(layout.addTabToPane).toHaveBeenCalledWith(
      'ws-pins',
      'pane-one',
      'orchestrator',
      '/repo',
      'claude-code',
      'claude --model claude-opus-5 --effort high',
      { agentLaunchConfig: { model: 'claude-opus-5', effort: 'high' } },
    );
    expect(state.statusCode).toBe(200);
  });
});
