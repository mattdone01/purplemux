import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({
  confirmCodexLaunchReceiptLocked: vi.fn(),
  withCodexTargetLock: vi.fn(async (_wsId: string, _tabId: string, work: () => Promise<unknown>) => work()),
}));
const cli = vi.hoisted(() => ({ authorizeWorkspaceInput: vi.fn() }));
const status = vi.hoisted(() => ({ applyConfirmedCodexLaunch: vi.fn() }));
vi.mock('@/lib/providers/codex/launch-lifecycle', () => lifecycle);
vi.mock('@/lib/cli-utils', () => cli);
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => status }));
vi.mock('@/lib/access-filter', () => ({ isRequestAllowed: vi.fn(() => true) }));

const response = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(body: unknown) { state.body = body; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const request = {
  method: 'POST',
  headers: { 'x-pmux-token': 'workspace-token' },
  socket: { remoteAddress: '127.0.0.1' },
  body: {
    workspaceId: 'ws-pins',
    tabId: 'tab-pins',
    generation: 'codex-generation',
    launcherPid: 1001,
    childPid: 1002,
  },
} as unknown as NextApiRequest;

describe('POST /api/codex/launch-confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cli.authorizeWorkspaceInput.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-pins' });
    lifecycle.confirmCodexLaunchReceiptLocked.mockResolvedValue({
      ok: true,
      state: 'confirmed',
      active: {
        generation: 'codex-generation',
        resumeSessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f',
      },
    });
  });

  it('updates in-memory status only after process proof confirms the generation', async () => {
    const { default: handler } = await import('@/pages/api/codex/launch-confirm');
    const { state, res } = response();
    await handler(request, res);
    expect(lifecycle.confirmCodexLaunchReceiptLocked).toHaveBeenCalledWith({
      workspaceId: 'ws-pins',
      tabId: 'tab-pins',
      generation: 'codex-generation',
      launcherPid: 1001,
      childPid: 1002,
    });
    expect(status.applyConfirmedCodexLaunch).toHaveBeenCalledWith(
      'tab-pins', 'codex-generation', '01a008c1-bb96-71d1-9769-b63ff478fd9f',
    );
    expect(state.body).toEqual({ generation: 'codex-generation', state: 'confirmed' });
  });

  it('does not bind status for a stale receipt', async () => {
    lifecycle.confirmCodexLaunchReceiptLocked.mockResolvedValue({
      ok: false,
      state: 'stale',
      reason: 'launch-generation-not-current',
    });
    const { default: handler } = await import('@/pages/api/codex/launch-confirm');
    const { state, res } = response();
    await handler(request, res);
    expect(state.statusCode).toBe(409);
    expect(status.applyConfirmedCodexLaunch).not.toHaveBeenCalled();
  });

  it('returns revalidated without applying startup status resets', async () => {
    lifecycle.confirmCodexLaunchReceiptLocked.mockResolvedValue({
      ok: true,
      state: 'revalidated',
      active: {
        generation: 'codex-generation',
        resumeSessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f',
      },
    });
    const { default: handler } = await import('@/pages/api/codex/launch-confirm');
    const { state, res } = response();
    await handler(request, res);

    expect(state.body).toEqual({ generation: 'codex-generation', state: 'revalidated' });
    expect(status.applyConfirmedCodexLaunch).not.toHaveBeenCalled();
  });
});
