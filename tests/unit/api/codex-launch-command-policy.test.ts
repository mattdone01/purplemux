import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const codex = vi.hoisted(() => ({ panelType: 'codex-cli', buildLaunchCommand: vi.fn() }));
const managed = vi.hoisted(() => ({ prepareCodexManagedLaunch: vi.fn() }));
const cli = vi.hoisted(() => ({ authorizeWorkspaceInput: vi.fn() }));

vi.mock('@/lib/providers/codex', () => ({ codexProvider: codex }));
vi.mock('@/lib/providers/codex/managed-launch', () => managed);
vi.mock('@/lib/cli-utils', () => cli);
vi.mock('@/lib/agent-availability', () => ({
  checkAgentAvailabilityForPanelType: vi.fn(async () => ({ ok: true })),
  toAgentAvailabilityError: vi.fn(),
}));
vi.mock('@/lib/workspace-store', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-active') }));

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

describe('POST /api/codex/launch-command lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codex.buildLaunchCommand.mockResolvedValue('legacy-command');
    managed.prepareCodexManagedLaunch.mockResolvedValue({
      ok: true,
      launch: {
        command: 'managed-command',
        generation: 'codex-generation',
        workspaceId: 'ws-pins',
        tabId: 'tab-pins',
        sessionName: 'pt-ws-pins-pane-one-tab-pins',
        resumeSessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f',
        launchedConfig: { model: 'gpt-5.6-sol', effort: 'high' },
      },
    });
    cli.authorizeWorkspaceInput.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-pins' });
  });

  it('prepares a managed resume intent without eagerly binding session metadata', async () => {
    const { default: handler } = await import('@/pages/api/codex/launch-command');
    const { state, res } = fakeResponse();
    const resumeSessionId = '01a008c1-bb96-71d1-9769-b63ff478fd9f';
    await handler({
      method: 'POST',
      body: { workspaceId: 'ws-pins', tabId: 'tab-pins', resumeSessionId },
    } as NextApiRequest, res);
    expect(managed.prepareCodexManagedLaunch).toHaveBeenCalledWith('ws-pins', 'tab-pins', resumeSessionId);
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      command: 'managed-command',
      generation: 'codex-generation',
      workspaceId: 'ws-pins',
      tabId: 'tab-pins',
      sessionName: 'pt-ws-pins-pane-one-tab-pins',
      resumeSessionId,
    });
  });

  it('preserves builder-only fresh launch for a not-yet-created unpinned tab', async () => {
    const { default: handler } = await import('@/pages/api/codex/launch-command');
    const { state, res } = fakeResponse();
    await handler({ method: 'POST', body: { workspaceId: 'ws-pins' } } as NextApiRequest, res);
    expect(codex.buildLaunchCommand).toHaveBeenCalledWith({ workspaceId: 'ws-pins' });
    expect(managed.prepareCodexManagedLaunch).not.toHaveBeenCalled();
    expect(state.body).toEqual({ command: 'legacy-command' });
  });

  it('denies a cross-workspace token before preparing an intent', async () => {
    cli.authorizeWorkspaceInput.mockResolvedValue(null);
    const { default: handler } = await import('@/pages/api/codex/launch-command');
    const { res } = fakeResponse();
    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'workspace-token' },
      body: { workspaceId: 'ws-other', tabId: 'tab-pins' },
    } as unknown as NextApiRequest, res);
    expect(managed.prepareCodexManagedLaunch).not.toHaveBeenCalled();
    expect(codex.buildLaunchCommand).not.toHaveBeenCalled();
  });

  it('rejects a resume without an existing tab identity', async () => {
    const { default: handler } = await import('@/pages/api/codex/launch-command');
    const { state, res } = fakeResponse();
    await handler({
      method: 'POST',
      body: { workspaceId: 'ws-pins', resumeSessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f' },
    } as NextApiRequest, res);
    expect(state.statusCode).toBe(400);
    expect(managed.prepareCodexManagedLaunch).not.toHaveBeenCalled();
  });
});
