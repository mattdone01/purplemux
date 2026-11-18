import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IOrphanHostFacts, IOrphanProcessFact } from '@/lib/tab-orphans';

const state = vi.hoisted(() => ({
  dir: '',
  workspaces: [] as Array<{ id: string }>,
  facts: { tree: { complete: true }, sessions: [], processes: [] } as IOrphanHostFacts | 'unavailable',
  jobs: [] as Array<{ pid: number; host?: string | null }>,
}));
const tmux = vi.hoisted(() => ({
  scanRemoteOrphans: vi.fn(async (_host: string, _url: string): Promise<IOrphanHostFacts | 'unavailable'> => state.facts),
  reapRemoteOrphans: vi.fn(async (_host: string, targets: ReadonlyArray<{ pid: number; start: string }>) => ({
    killed: targets.map((t) => t.pid), survivors: [] as number[], refused: [] as Array<{ pid: number; refusal: 'protected' }>,
  })),
}));
const audit = vi.hoisted(() => ({ appendCoordinationAudit: vi.fn(async (_entry: Record<string, unknown>) => true) }));

vi.mock('@/lib/workspace-store', () => ({ getWorkspaces: vi.fn(async () => ({ workspaces: state.workspaces })) }));
vi.mock('@/lib/layout-store', () => ({ resolveLayoutFile: (wsId: string) => path.join(state.dir, wsId, 'layout.json') }));
vi.mock('@/lib/remote-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/remote-host')>()),
  readRemoteHosts: vi.fn(async () => ['host-a', 'host-b']),
  resolveCallbackUrl: vi.fn(async () => 'http://origin-a:8022'),
}));
vi.mock('@/lib/tmux', () => ({
  ...tmux,
  getDescendantPids: vi.fn(async () => []),
  getTmuxServerPid: vi.fn(async () => null),
  getTmuxSocketPath: vi.fn(async () => null),
  readLocalTree: vi.fn(async () => ({ readable: true, serverPid: null, panes: [] })),
}));
vi.mock('@/lib/liveness-store', () => ({ readAllLiveness: vi.fn(async () => ({ probes: [], jobs: state.jobs })) }));
vi.mock('@/lib/coordination-audit', () => audit);
// The local host's scan is tested over a fake /proc in tab-orphans.test.ts; here it reads nothing of this host.
vi.mock('@/lib/tab-orphans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tab-orphans')>()),
  collectLocalOrphanFacts: vi.fn(async () => ({ tree: { complete: true }, sessions: [], processes: [] })),
}));

const SECRET = 'planted-secret-value-91c2';

const fact = (pid: number, over: Partial<IOrphanProcessFact> = {}): IOrphanProcessFact => ({
  pid, ppid: 1, comm: 'claude', ageMs: 10 * 60_000, cwd: '/work/a', start: `s${pid}`, tabId: null,
  urlMatch: true, socketMatch: false, underServer: false, heldBy: null, heldKnown: true, agentAbove: false, agent: true, ...over,
});

const writeLayout = async (wsId: string, content: string) => {
  await fs.mkdir(path.join(state.dir, wsId), { recursive: true });
  await fs.writeFile(path.join(state.dir, wsId, 'layout.json'), content);
};

const layoutWith = (tabs: Array<{ id: string; sessionName: string; host?: string }>) => JSON.stringify({
  root: { type: 'pane', id: 'pane-p1', tabs: tabs.map((t, order) => ({ ...t, name: t.id, order, panelType: 'claude-code' })), activeTabId: null },
});

beforeEach(async () => {
  vi.clearAllMocks();
  state.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-orphan-service-'));
  state.workspaces = [{ id: 'ws-test1' }, { id: 'ws-test2' }];
  state.jobs = [];
  await writeLayout('ws-test1', layoutWith([
    { id: 'tab-aaaa', sessionName: 'pt-ws-test1-pane-p1-tab-aaaa', host: 'host-a' },
    { id: 'tab-dddd', sessionName: 'pt-ws-test1-pane-p1-tab-dddd' },
  ]));
  state.facts = {
    tree: { complete: true },
    sessions: [{ name: 'pt-ws-test1-pane-p1-tab-aaaa', ageMs: 600_000 }],
    processes: [
      fact(301, { tabId: 'tab-gone', agent: false, comm: 'sleep' }),
      fact(302, { tabId: 'tab-aaaa' }),
      fact(303, { tabId: 'tab-aaaa', heldBy: 'pt-ws-test1-pane-p1-tab-aaaa', underServer: true }),
      fact(304),
      fact(305, { tabId: 'tab-gone', ageMs: 5_000 }),
    ],
  };
});

afterEach(async () => {
  await fs.rm(state.dir, { recursive: true, force: true });
});

describe('readOwnership', () => {
  it('reads every layout; a missing one owns nothing and is named', async () => {
    const { readOwnership } = await import('@/lib/tab-orphans-service');
    const owned = await readOwnership();
    expect(owned.workspaces).toBe(2);
    expect(owned.missingLayouts).toEqual(['ws-test2']);
    expect([...owned.tabs.keys()].sort()).toEqual(['tab-aaaa', 'tab-dddd']);
    expect(owned.tabs.get('tab-aaaa')).toEqual({ workspaceId: 'ws-test1', sessionName: 'pt-ws-test1-pane-p1-tab-aaaa', host: 'host-a' });
  });

  it('a layout that does not parse refuses the sweep: its tabs would all read as orphans', async () => {
    await writeLayout('ws-test2', '{ not json');
    const { readOwnership, sweepOrphans } = await import('@/lib/tab-orphans-service');
    await expect(readOwnership()).rejects.toMatchObject({ code: 'conflict' });
    await expect(sweepOrphans({ mayReap: () => true })).rejects.toMatchObject({ code: 'conflict' });
    expect(tmux.reapRemoteOrphans).not.toHaveBeenCalled();
  });
});

describe('sweepOrphans', () => {
  it('lists the local host and each remote.hosts host that owns a tab', async () => {
    const { sweepOrphans } = await import('@/lib/tab-orphans-service');
    const { hosts } = await sweepOrphans();
    expect(hosts.map((h) => h.host)).toEqual(['local', 'host-a']);
    expect(tmux.scanRemoteOrphans).toHaveBeenCalledWith('host-a', 'http://origin-a:8022');
    expect(hosts[1].orphans.map((o) => `${o.kind}:${o.pid}`)).toEqual(['unowned-tab:301', 'duplicate-agent:302', 'unowned-tab:305', 'unmarked-agent:304']);
    expect(tmux.reapRemoteOrphans).not.toHaveBeenCalled();
  });

  it('a host outside remote.hosts is refused', async () => {
    const { sweepOrphans } = await import('@/lib/tab-orphans-service');
    await expect(sweepOrphans({ host: 'host-z' })).rejects.toMatchObject({ code: 'remote-host-invalid' });
  });

  it('a host that does not answer is reported unreachable, never empty', async () => {
    tmux.scanRemoteOrphans.mockRejectedValueOnce(new Error('the orphan scan on host-a did not answer (timed out)'));
    const { sweepOrphans } = await import('@/lib/tab-orphans-service');
    const { hosts } = await sweepOrphans({ host: 'host-a' });
    expect(hosts).toEqual([{ host: 'host-a', status: 'unreachable', error: 'the orphan scan on host-a did not answer (timed out)', orphans: [] }]);
  });

  it('--reap signals only kinds (i) and (ii), refuses the young and the forbidden, and audits each kill without environ values', async () => {
    await writeLayout('ws-test2', layoutWith([]));
    const { sweepOrphans } = await import('@/lib/tab-orphans-service');
    const { hosts } = await sweepOrphans({ host: 'host-a', mayReap: (entry) => entry.kind === 'unowned-tab' });
    expect(tmux.reapRemoteOrphans).toHaveBeenCalledWith('host-a', [{ pid: 301, start: 's301' }]);
    expect(hosts[0].reaped).toEqual([
      { pid: 302, comm: 'claude', tabId: 'tab-aaaa', kind: 'duplicate-agent', outcome: 'refused', refusal: 'forbidden' },
      { pid: 305, comm: 'claude', tabId: 'tab-gone', kind: 'unowned-tab', outcome: 'refused', refusal: 'too-young' },
      { pid: 301, comm: 'sleep', tabId: 'tab-gone', kind: 'unowned-tab', outcome: 'killed' },
    ]);
    expect(audit.appendCoordinationAudit).toHaveBeenCalledTimes(1);
    expect(audit.appendCoordinationAudit).toHaveBeenCalledWith({ event: 'tab-orphan-reap', host: 'host-a', pid: 301, comm: 'sleep', tabId: 'tab-gone', reason: 'unowned-tab', outcome: 'killed' });
    expect(JSON.stringify(hosts)).not.toContain(SECRET);
  });

  it('a reap whose host stops answering reports each target unknown and audits it', async () => {
    await writeLayout('ws-test2', layoutWith([]));
    tmux.reapRemoteOrphans.mockRejectedValueOnce(new Error('the orphan reap on host-a did not answer (timed out); its outcome is unknown'));
    const { sweepOrphans } = await import('@/lib/tab-orphans-service');
    const { hosts } = await sweepOrphans({ host: 'host-a', mayReap: () => true });
    expect(hosts[0].reaped?.filter((r) => r.outcome === 'unknown').map((r) => r.pid)).toEqual([301, 302]);
    expect(hosts[0].error).toContain('outcome is unknown');
    expect(audit.appendCoordinationAudit).toHaveBeenCalledTimes(2);
  });

  it('a registered background job of the tab is no duplicate agent', async () => {
    state.jobs = [{ pid: 302, host: 'host-a' }];
    const { sweepOrphans } = await import('@/lib/tab-orphans-service');
    const { hosts } = await sweepOrphans({ host: 'host-a' });
    expect(hosts[0].orphans.map((o) => o.pid)).not.toContain(302);
  });

  it('a workspace whose layout file is missing: no unowned-tab process is reaped, its tabs may be live', async () => {
    const { sweepOrphans } = await import('@/lib/tab-orphans-service');
    const { hosts } = await sweepOrphans({ host: 'host-a', mayReap: () => true });
    expect(hosts[0].reaped?.filter((r) => r.kind === 'unowned-tab').map((r) => [r.pid, r.outcome, r.refusal]))
      .toEqual([[301, 'refused', 'layout-missing'], [305, 'refused', 'too-young']]);
    expect(tmux.reapRemoteOrphans).toHaveBeenCalledWith('host-a', [{ pid: 302, start: 's302' }]);
  });

  it('a scan whose pane tree was not read: every target is refused tree-unreadable and nothing reaches the host', async () => {
    await writeLayout('ws-test2', layoutWith([]));
    state.facts = { ...(state.facts as IOrphanHostFacts), tree: { complete: false, reason: 'process table unreadable' } };
    const { sweepOrphans } = await import('@/lib/tab-orphans-service');
    const { hosts } = await sweepOrphans({ host: 'host-a', mayReap: () => true });
    expect(hosts[0].tree).toEqual({ complete: false, reason: 'process table unreadable' });
    expect(hosts[0].reaped?.every((r) => r.outcome === 'refused' && r.refusal === 'tree-unreadable')).toBe(true);
    expect(tmux.reapRemoteOrphans).not.toHaveBeenCalled();
    expect(audit.appendCoordinationAudit).not.toHaveBeenCalled();
  });

  it('a remote host without /proc is unavailable, never ok with no orphans', async () => {
    state.facts = 'unavailable';
    const { sweepOrphans } = await import('@/lib/tab-orphans-service');
    const { hosts } = await sweepOrphans({ host: 'host-a', mayReap: () => true });
    expect(hosts).toEqual([{ host: 'host-a', status: 'unavailable', orphans: [] }]);
  });

  it('no workspace read: a reap is refused, since every marked process would read as an orphan', async () => {
    state.workspaces = [];
    const { sweepOrphans } = await import('@/lib/tab-orphans-service');
    await expect(sweepOrphans({ mayReap: () => true })).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('findOrphanSuspects', () => {
  afterEach(() => vi.useRealTimers());

  it('dates a suspect from the clock read before the scan: a slow scan or ssh never moves a start later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const T0 = 1_700_000_000_000;
    vi.setSystemTime(T0);
    tmux.scanRemoteOrphans.mockImplementationOnce(async () => {
      vi.setSystemTime(T0 + 30_000);
      return { tree: { complete: true }, sessions: [], processes: [fact(304, { ageMs: 60_000 })] };
    });
    const { findOrphanSuspects } = await import('@/lib/tab-orphans-service');
    expect(await findOrphanSuspects('host-a')).toEqual([{ pid: 304, comm: 'claude', cwd: '/work/a', startedAt: T0 - 60_000, heldBy: null }]);
  });

  it('a host that cannot be read gives no suspects (null), and one without /proc none either', async () => {
    const { findOrphanSuspects } = await import('@/lib/tab-orphans-service');
    tmux.scanRemoteOrphans.mockRejectedValueOnce(new Error('the orphan scan on host-a did not answer (timed out)'));
    expect(await findOrphanSuspects('host-a')).toBeNull();
    tmux.scanRemoteOrphans.mockResolvedValueOnce('unavailable');
    expect(await findOrphanSuspects('host-a')).toBeNull();
  });
});
