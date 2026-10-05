import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const presented = vi.hoisted(() => vi.fn());
vi.mock('@/lib/cli-token', () => ({ verifyTokenValue: () => false }));
vi.mock('@/lib/tab-token', () => ({
  resolveTabToken: (value: string) => value === 'hook-token' ? { tabId: 'tab-hook', record: { workspaceId: 'ws-own', origin: 'hook' } } : null,
  tokenOrigin: () => 'hook', notePresented: presented,
}));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: vi.fn(async () => null) }));

const req = (method = 'POST') => ({ method, headers: { 'x-pmux-token': 'hook-token' }, query: {}, body: { workspaceId: 'ws-other' } } as unknown as NextApiRequest);
const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as NextApiResponse);

beforeEach(() => vi.clearAllMocks());
describe('authorization does not persist denied hook-token presentations', () => {
  it('scope inspection can defer presentation while legacy default callers retain it', async () => {
    const { resolveCliScope } = await import('@/lib/workspace-token');
    expect(resolveCliScope(req(), { recordPresentation: false })).toMatchObject({ workspaceId: 'ws-own', tabIdentity: 'hook' });
    expect(presented).not.toHaveBeenCalled();
    resolveCliScope(req());
    expect(presented).toHaveBeenCalledOnce();
  });
  it.each(['GET', 'POST', 'PATCH', 'DELETE'])('does not record a rejected %s', async (method) => {
    const { authorizeWorkspace } = await import('@/lib/cli-utils');
    expect(await authorizeWorkspace(req(method), res(), 'ws-other')).toBeNull();
    expect(presented).not.toHaveBeenCalled();
  });
  it('records accepted local requests', async () => {
    const { authorizeWorkspaceMutation } = await import('@/lib/cli-utils');
    expect(await authorizeWorkspaceMutation(req(), res(), 'ws-own')).toMatchObject({ workspaceId: 'ws-own' });
    expect(presented).toHaveBeenCalledOnce();
  });
  it('CLI tab creation does not record before its shared mutation guard', async () => {
    const { default: handler } = await import('@/pages/api/cli/tabs');
    await handler(req(), res());
    expect(presented).not.toHaveBeenCalled();
  });
});
