vi.mock('@/lib/human-mutation', () => ({ authorizeHumanMutation: vi.fn(async () => true) }));
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const layout = vi.hoisted(() => ({ addTabToPane: vi.fn() }));
const claude = vi.hoisted(() => ({ buildClaudeFlags: vi.fn() }));
const recovery = vi.hoisted(() => ({ start: vi.fn() }));
const manager = vi.hoisted(() => ({
  registerTab: vi.fn(),
  markAgentLaunch: vi.fn(),
  queueKickoffPrompt: vi.fn(),
}));

vi.mock('@/lib/layout-store', () => layout);
vi.mock('@/lib/orchestration-recovery', () => ({ startOrchestrationTransaction: recovery.start }));
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
    recovery.start.mockImplementation(async (_id, _options, _template, create) => ({ workspace: { orchestration: { revision: 1 } }, tab: await create({ id: 'ws-pins', directories: ['/repo'] }) }));
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
        prompt: 'Run the epic', expectedRevision: 0,
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

it.each([undefined, -1, '0'])('human start precondition %s creates nothing and queues no kickoff', async (expectedRevision) => {
  vi.clearAllMocks();
  const { default: handler } = await import('@/pages/api/workspace/[workspaceId]/orchestrate');
  const { state, res } = fakeResponse();
  await handler({ method: 'POST', query: { workspaceId: 'ws-pins' }, body: { prompt: 'work', expectedRevision } } as unknown as NextApiRequest, res);
  expect(state.statusCode).toBe(expectedRevision === undefined ? 428 : 400);
  expect(recovery.start).not.toHaveBeenCalled(); expect(layout.addTabToPane).not.toHaveBeenCalled(); expect(manager.queueKickoffPrompt).not.toHaveBeenCalled();
});
it('reports a created undesignated tab on commit failure and queues no kickoff', async () => {
  vi.clearAllMocks();
  const { OrchestrationError } = await import('@/lib/orchestration-contract');
  recovery.start.mockRejectedValueOnce(new OrchestrationError(503, 'orchestration-persist-failed', 'Tab new is undesignated', undefined, 'new'));
  const { default: handler } = await import('@/pages/api/workspace/[workspaceId]/orchestrate'); const { state, res } = fakeResponse();
  await handler({ method: 'POST', query: { workspaceId: 'ws-pins' }, body: { prompt: 'work', expectedRevision: 0 } } as unknown as NextApiRequest, res);
  expect(state).toMatchObject({ statusCode: 503, body: { undesignatedTabId: 'new' } }); expect(manager.queueKickoffPrompt).not.toHaveBeenCalled();
});
