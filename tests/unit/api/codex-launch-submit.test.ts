import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const managed = vi.hoisted(() => ({
  submitCodexManagedLaunch: vi.fn(),
  waitForCodexManagedLaunch: vi.fn(),
}));
const cli = vi.hoisted(() => ({ authorizeWorkspaceInput: vi.fn() }));
vi.mock('@/lib/providers/codex/managed-launch', () => managed);
vi.mock('@/lib/cli-utils', () => cli);

const response = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(body: unknown) { state.body = body; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

describe('POST /api/codex/launch-submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cli.authorizeWorkspaceInput.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-pins' });
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
  });

  it('submits the exact prepared generation through the server', async () => {
    const { default: handler } = await import('@/pages/api/codex/launch-submit');
    const { state, res } = response();
    await handler({
      method: 'POST',
      body: { workspaceId: 'ws-pins', tabId: 'tab-pins', generation: 'codex-generation' },
    } as NextApiRequest, res);
    expect(managed.submitCodexManagedLaunch).toHaveBeenCalledWith('ws-pins', 'tab-pins', 'codex-generation');
    expect(managed.waitForCodexManagedLaunch).toHaveBeenCalledWith(
      'ws-pins', 'tab-pins', 'codex-generation',
    );
    expect(state.statusCode).toBe(202);
    expect(state.body).toEqual({ generation: 'codex-generation', phase: 'submitted' });
  });

  it('does not submit when workspace input authorization fails', async () => {
    cli.authorizeWorkspaceInput.mockResolvedValue(null);
    const { default: handler } = await import('@/pages/api/codex/launch-submit');
    const { res } = response();
    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'wrong-token' },
      body: { workspaceId: 'ws-pins', tabId: 'tab-pins', generation: 'codex-generation' },
    } as unknown as NextApiRequest, res);
    expect(managed.submitCodexManagedLaunch).not.toHaveBeenCalled();
  });
});
