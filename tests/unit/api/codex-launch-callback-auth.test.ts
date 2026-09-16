import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const codex = vi.hoisted(() => ({ buildCodexRuntimeArgs: vi.fn() }));
const lifecycle = vi.hoisted(() => ({
  resolveCodexLaunchIntent: vi.fn(),
  confirmCodexLaunchReceiptLocked: vi.fn(),
  withCodexTargetLock: vi.fn(async (_wsId: string, _tabId: string, work: () => Promise<unknown>) => work()),
}));
const status = vi.hoisted(() => ({ applyConfirmedCodexLaunch: vi.fn() }));

vi.mock('@/lib/providers/codex', () => codex);
vi.mock('@/lib/providers/codex/launch-lifecycle', () => lifecycle);
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => status }));
vi.mock('@/lib/workspace-store', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-pins'),
  getWorkspaceById: vi.fn(),
}));
vi.mock('@/lib/workspace-token', () => ({
  resolveCliScope: (req: NextApiRequest) => {
    const token = req.headers?.['x-pmux-token'];
    if (token === 'workspace-own') return { type: 'workspace', workspaceId: 'ws-pins' };
    if (token === 'workspace-cross') return { type: 'workspace', workspaceId: 'ws-other' };
    if (token === 'global') return { type: 'admin' };
    return null;
  },
}));

const response = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(body: unknown) { state.body = body; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const argsRequest = (token?: string): NextApiRequest => ({
  method: 'POST',
  headers: token ? { 'x-pmux-token': token } : {},
  body: {
    workspaceId: 'ws-pins',
    tabId: 'tab-pins',
    sessionName: 'pt-ws-pins-pane-one-tab-pins',
    generation: 'codex-generation',
  },
} as unknown as NextApiRequest);

const legacyArgsRequest = (token?: string): NextApiRequest => ({
  method: 'POST',
  headers: token ? { 'x-pmux-token': token } : {},
  body: { workspaceId: 'ws-pins', model: 'gpt-5.6-sol', effort: 'high' },
} as unknown as NextApiRequest);

const confirmRequest = (
  token?: string,
  options: { remoteAddress?: string; forwardedFor?: string } = {},
): NextApiRequest => ({
  method: 'POST',
  headers: {
    ...(token ? { 'x-pmux-token': token } : {}),
    ...(options.forwardedFor ? { 'x-forwarded-for': options.forwardedFor } : {}),
  },
  socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  body: {
    workspaceId: 'ws-pins',
    tabId: 'tab-pins',
    generation: 'codex-generation',
    launcherPid: 1001,
    childPid: 1002,
  },
} as unknown as NextApiRequest);

describe('token-only Codex launcher callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codex.buildCodexRuntimeArgs.mockResolvedValue(['--model', 'gpt-5.6-sol']);
    lifecycle.resolveCodexLaunchIntent.mockResolvedValue({
      resumeSessionId: null,
      launchedConfig: { model: 'gpt-5.6-sol', effort: 'high' },
    });
    lifecycle.confirmCodexLaunchReceiptLocked.mockResolvedValue({
      ok: true,
      state: 'confirmed',
      active: { generation: 'codex-generation', resumeSessionId: null },
    });
  });

  it('keeps callback routes outside the cookie proxy and leaves browser Codex routes guarded', async () => {
    const { config } = await import('@/proxy');
    const guarded = new RegExp(`^${config.matcher[0]}$`);

    expect(guarded.test('/api/cli/codex/launch-args')).toBe(false);
    expect(guarded.test('/api/cli/codex/launch-confirm')).toBe(false);
    expect(guarded.test('/api/codex/launch-command')).toBe(true);
  });

  it('allows launch arguments for the target workspace token', async () => {
    const { default: handler } = await import('@/pages/api/cli/codex/launch-args');
    const { state, res } = response();
    await handler(argsRequest('workspace-own'), res);

    expect(state.statusCode).toBe(200);
    expect(lifecycle.resolveCodexLaunchIntent).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', undefined],
    ['global', 'global'],
    ['cross-workspace', 'workspace-cross'],
  ])('rejects %s authorization before resolving launch arguments', async (_label, token) => {
    const { default: handler } = await import('@/pages/api/cli/codex/launch-args');
    const { state, res } = response();
    await handler(argsRequest(token), res);

    expect(state.statusCode).toBe(403);
    expect(lifecycle.resolveCodexLaunchIntent).not.toHaveBeenCalled();
  });

  it('authorizes the legacy argument branch against its resolved workspace', async () => {
    const { default: handler } = await import('@/pages/api/cli/codex/launch-args');
    const allowed = response();
    await handler(legacyArgsRequest('workspace-own'), allowed.res);

    expect(allowed.state.statusCode).toBe(200);
    expect(codex.buildCodexRuntimeArgs).toHaveBeenCalledWith(
      'ws-pins', undefined, { model: 'gpt-5.6-sol', effort: 'high' },
    );

    vi.clearAllMocks();
    const denied = response();
    await handler(legacyArgsRequest('workspace-cross'), denied.res);

    expect(denied.state.statusCode).toBe(403);
    expect(codex.buildCodexRuntimeArgs).not.toHaveBeenCalled();
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'allows launch confirmation for the target workspace token on loopback %s',
    async (remoteAddress) => {
      const { default: handler } = await import('@/pages/api/cli/codex/launch-confirm');
      const { state, res } = response();
      await handler(confirmRequest('workspace-own', { remoteAddress }), res);

      expect(state.statusCode).toBe(200);
      expect(lifecycle.confirmCodexLaunchReceiptLocked).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['missing', undefined],
    ['global', 'global'],
    ['cross-workspace', 'workspace-cross'],
  ])('rejects %s authorization before confirming a launch', async (_label, token) => {
    const { default: handler } = await import('@/pages/api/cli/codex/launch-confirm');
    const { state, res } = response();
    await handler(confirmRequest(token), res);

    expect(state.statusCode).toBe(403);
    expect(lifecycle.confirmCodexLaunchReceiptLocked).not.toHaveBeenCalled();
  });

  it('rejects non-loopback confirmation even when a forwarded header claims loopback', async () => {
    const { default: handler } = await import('@/pages/api/cli/codex/launch-confirm');
    const { state, res } = response();
    await handler(confirmRequest('workspace-own', {
      remoteAddress: '100.64.0.10',
      forwardedFor: '127.0.0.1',
    }), res);

    expect(state.statusCode).toBe(403);
    expect(lifecycle.confirmCodexLaunchReceiptLocked).not.toHaveBeenCalled();
  });
});
