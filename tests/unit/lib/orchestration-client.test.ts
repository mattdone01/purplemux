import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock('@/hooks/use-workspace-store', () => ({ default: { getState: () => ({ syncWorkspaces: fixture.sync }) } }));
import { patchWorkspaceOrchestration, startOrchestration } from '@/lib/orchestration-client';
beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); fixture.sync.mockReset(); });
describe('human orchestration preconditions and conflicts', () => {
  it('sends the displayed revision and explicit replacement once, refreshing a conflict without replay', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ code: 'orchestration-conflict', error: 'changed', orchestration: { revision: 8 } }), { status: 409 }));
    await expect(patchWorkspaceOrchestration('ws-a', { enabled: true, orchestratorTabId: 'next' }, { expectedRevision: 7, mode: 'replace' })).rejects.toMatchObject({ code: 'orchestration-conflict', orchestration: { revision: 8 } });
    expect(fetch).toHaveBeenCalledOnce(); expect(fixture.sync).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ orchestration: { enabled: true, orchestratorTabId: 'next' }, expectedRevision: 7, mode: 'replace' });
  });
  it('reports an undesignated created tab on persistence failure without another start', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ code: 'orchestration-persist-failed', undesignatedTabId: 'new', error: 'Refresh' }), { status: 503 }));
    await expect(startOrchestration('ws-a', { paneId: 'p', prompt: 'work', expectedRevision: 0, mode: 'update' })).rejects.toMatchObject({ undesignatedTabId: 'new' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
