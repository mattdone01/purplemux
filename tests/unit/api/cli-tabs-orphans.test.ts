import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IOrphanEntry, IOrphanProcessFact } from '@/lib/tab-orphans';
import type { TMayReap } from '@/lib/tab-orphans-service';

const scope = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
const service = vi.hoisted(() => ({
  sweepOrphans: vi.fn(async (_opts: { host?: string; mayReap?: TMayReap }) => ({ hosts: [] as unknown[] })),
}));
const sm = vi.hoisted(() => ({ selectedScrumMasterMayMutate: vi.fn(async () => false) }));

vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: () => scope.value }));
vi.mock('@/lib/lease-http', () => ({
  requireCaller: async (_req: NextApiRequest, res: NextApiResponse) => {
    if (!scope.value) {
      res.status(403).json({ code: 'forbidden' });
      return null;
    }
    return { scope: scope.value };
  },
}));
vi.mock('@/lib/cli-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-utils')>()),
  selectedScrumMasterMayMutate: sm.selectedScrumMasterMayMutate,
}));
vi.mock('@/lib/tab-orphans-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tab-orphans-service')>()),
  sweepOrphans: service.sweepOrphans,
}));

const call = async (method: string, query: Record<string, string> = {}, body: unknown = undefined) => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  const { default: handler } = await import('@/pages/api/cli/tabs/orphans');
  await handler({ method, query, body, headers: {}, url: '/api/cli/tabs/orphans' } as unknown as NextApiRequest, res);
  return state;
};

const fact = (pid: number, tabId: string): IOrphanProcessFact => ({
  pid, ppid: 1, comm: 'claude', ageMs: 600_000, cwd: '/w', start: '1', tabId, urlMatch: true, socketMatch: false, underServer: false, heldBy: null, heldKnown: true, agentAbove: false, agent: true,
});

describe('/api/cli/tabs/orphans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope.value = { type: 'workspace', workspaceId: 'ws-test1', tabId: 'tab-aaaa', tabVerified: true };
  });

  it('GET lists for any caller, the global token included, and passes the host', async () => {
    scope.value = { type: 'admin' };
    const state = await call('GET', { host: 'host-a' });
    expect(state.statusCode).toBe(200);
    expect(service.sweepOrphans).toHaveBeenCalledWith({ host: 'host-a', mayReap: undefined });
  });

  it('POST from the global token is refused: it mutates no workspace, and nothing is scanned', async () => {
    scope.value = { type: 'admin' };
    const state = await call('POST', {}, { reap: true });
    expect(state.statusCode).toBe(403);
    expect(state.body).toMatchObject({ code: 'forbidden' });
    expect(service.sweepOrphans).not.toHaveBeenCalled();
  });

  it('POST needs reap: true', async () => {
    expect((await call('POST', {}, {})).statusCode).toBe(400);
    expect(service.sweepOrphans).not.toHaveBeenCalled();
  });

  it('a workspace caller reaps a closed tab\'s process and its own duplicate agent, never another workspace\'s', async () => {
    expect((await call('POST', {}, { reap: true, host: 'local' })).statusCode).toBe(200);
    const { host, mayReap } = service.sweepOrphans.mock.calls[0][0];
    expect(host).toBe('local');
    const entries: IOrphanEntry[] = [
      { kind: 'unowned-tab', process: fact(1, 'tab-gone') },
      { kind: 'duplicate-agent', process: fact(2, 'tab-aaaa'), workspaceId: 'ws-test1' },
      { kind: 'duplicate-agent', process: fact(3, 'tab-bbbb'), workspaceId: 'ws-test2' },
      { kind: 'unmarked-agent', process: fact(4, 'tab-cccc') },
    ];
    expect(await Promise.all(entries.map((e) => mayReap!(e)))).toEqual([true, true, false, false]);
    expect(sm.selectedScrumMasterMayMutate).toHaveBeenCalledWith(scope.value, 'ws-test2', '/api/cli/tabs/orphans');
  });

  it('maps a sweep refusal to its code', async () => {
    const { OrphanSweepError } = await import('@/lib/tab-orphans-service');
    service.sweepOrphans.mockRejectedValueOnce(new OrphanSweepError('remote-host-invalid', 'host-z is not a host of remote.hosts'));
    expect(await call('GET', { host: 'host-z' })).toMatchObject({ statusCode: 400, body: { code: 'remote-host-invalid' } });
    service.sweepOrphans.mockRejectedValueOnce(new OrphanSweepError('conflict', 'the layout of ws-test1 is unreadable'));
    expect(await call('GET')).toMatchObject({ statusCode: 409, body: { code: 'conflict' } });
  });
});
