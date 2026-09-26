import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it, vi } from 'vitest';

const scope = vi.hoisted(() => ({ resolveCliScope: vi.fn() }));
vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: scope.resolveCliScope }));

const call = async () => {
  const { default: handler } = await import('@/pages/api/cli/api-guide');
  const state = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.status = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    send(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({ method: 'GET', headers: {} } as NextApiRequest, res);
  return state;
};

describe('GET /api/cli/api-guide', () => {
  it('serves any resolved caller, a tab token included', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-1', tabVerified: true });
    const state = await call();
    expect(state.status).toBe(200);
    expect(String(state.body)).toContain('## Caller identity');
  });

  it('refuses a caller no token resolves', async () => {
    scope.resolveCliScope.mockReturnValue(null);
    expect((await call()).status).toBe(403);
  });
});
