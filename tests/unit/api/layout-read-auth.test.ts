import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({ read: vi.fn(), initialize: vi.fn(), workspace: vi.fn() }));
vi.mock('@/lib/workspace-layout-read', () => ({ readWorkspaceLayout: deps.read }));
vi.mock('@/lib/layout-store', () => ({ getLayout: deps.initialize, patchLayout: vi.fn() }));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: deps.workspace, getActiveWorkspaceId: vi.fn() }));
vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: () => ({ type: 'admin' }) }));

const call = async () => {
  const { default: handler } = await import('@/pages/api/layout');
  const result = { code: 0, body: undefined as unknown };
  const res = { status(code: number) { result.code = code; return this; }, json(body: unknown) { result.body = body; return this; } } as unknown as NextApiResponse;
  await handler({ method: 'GET', query: { workspace: 'ws-foreign' }, headers: { 'x-pmux-token': 'global' } } as unknown as NextApiRequest, res);
  return result;
};

describe('global-token UI layout GET remains a read', () => {
  beforeEach(() => vi.clearAllMocks());
  it('returns an existing layout without initializing sessions', async () => {
    deps.read.mockResolvedValue({ root: { type: 'pane' } });
    expect((await call()).code).toBe(200);
    expect(deps.initialize).not.toHaveBeenCalled();
  });
  it('missing layout never starts a default tab', async () => {
    deps.read.mockResolvedValue(null);
    expect((await call()).code).toBe(404);
    expect(deps.initialize).not.toHaveBeenCalled();
    expect(deps.workspace).not.toHaveBeenCalled();
  });
  it('unreadable layout fails without default creation', async () => {
    deps.read.mockRejectedValue(new Error('unavailable'));
    expect((await call()).code).toBe(500);
    expect(deps.initialize).not.toHaveBeenCalled();
  });
});
