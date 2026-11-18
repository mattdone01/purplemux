import { describe, expect, it } from 'vitest';
import {
  ORPHAN_MIN_AGE_MS,
  classifyOrphans,
  collectLocalOrphanFacts,
  orphanReapAudit,
  readEnvironMarks,
  reapLocalOrphans,
  reapRefusal,
  suspectForTab,
  suspectsOf,
  viewOrphan,
  type ILocalOrphanScope,
  type IOrphanEntry,
  type IOrphanOwnership,
  type IOrphanReapTarget,
  type IOrphanScanDeps,
  type ISuspectPeer,
  type TLocalTreeRead,
} from '@/lib/tab-orphans';

const SECRET = 'planted-secret-value-7f3a';
const URL_OURS = 'http://origin-a:8022';
const SOCKET = '/tmp/tmux-1000/purple';
const MIN = 60_000;

interface IFakeProc {
  ppid: number;
  uid?: number;
  environ?: string[];
  comm?: string;
  argv?: string[];
  cwd?: string;
  ageMs?: number;
  ignoresTerm?: boolean;
}

const env = (...entries: string[]) => Buffer.from(entries.join('\0') + '\0');

const fakeProc = (procs: Record<number, IFakeProc>, opts: { protectedPids?: number[]; serverDescendants?: number[]; unreadableParents?: number[] } = {}) => {
  const alive = new Set(Object.keys(procs).map(Number));
  const starts = new Map([...alive].map((pid) => [pid, `start-${pid}`]));
  const signals: string[] = [];
  let clock = 0;
  const deps: IOrphanScanDeps = {
    procAvailable: async () => true,
    listPids: async () => [...alive],
    readEnviron: async (pid) => (alive.has(pid) && procs[pid].environ ? env(...procs[pid].environ!) : alive.has(pid) ? env() : null),
    ownerUid: async (pid) => (alive.has(pid) ? procs[pid].uid ?? 1000 : null),
    describe: async (pid) => ({ pid, comm: procs[pid]?.comm ?? '', args: (procs[pid]?.argv ?? []).join(' ') }),
    descendants: async () => [],
    processGroup: async (pid) => pid,
    isAlive: (pid) => alive.has(pid),
    startTime: async (pid) => (alive.has(pid) ? starts.get(pid) ?? null : null),
    protectedPids: async () => opts.protectedPids ?? [],
    serverDescendants: async () => opts.serverDescendants ?? [],
    kill: (pid, sig) => {
      signals.push(`${sig}:${pid}`);
      if (sig === 'SIGKILL' || (sig === 'SIGTERM' && !procs[pid]?.ignoresTerm)) alive.delete(pid);
    },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    selfPid: 2,
    uid: 1000,
    parentPid: async (pid) => (opts.unreadableParents?.includes(pid) ? null : alive.has(pid) || procs[pid] ? procs[pid]?.ppid ?? null : null),
    comm: async (pid) => (alive.has(pid) ? procs[pid].comm ?? 'sh' : null),
    argv: async (pid) => (alive.has(pid) ? procs[pid].argv ?? [procs[pid].comm ?? 'sh'] : null),
    cwd: async (pid) => (alive.has(pid) ? procs[pid].cwd ?? '/work/a' : null),
    ageMs: async (pid) => (alive.has(pid) ? procs[pid].ageMs ?? 10 * MIN : null),
  };
  return { deps, signals, alive, starts };
};

const claude = { comm: 'claude', argv: ['/usr/local/bin/claude', '--resume'] };
const tmuxEnv = (pane: number) => `TMUX=${SOCKET},${pane},0`;

// The tmux server is 100. Session pt-ws-test1-pane-p1-tab-aaaa has pane 101 (tab-aaaa's agent 102 runs in it).
// Session pt-ws-test1-pane-p2-tab-zzzz has pane 120: no layout owns it.
const TREE: TLocalTreeRead = {
  readable: true,
  serverPid: 100,
  panes: [
    { session: 'pt-ws-test1-pane-p1-tab-aaaa', panePid: 101, ageMs: 30 * MIN },
    { session: 'pt-ws-test1-pane-p2-tab-zzzz', panePid: 120, ageMs: 30 * MIN },
  ],
};
const scopeOf = (tree: TLocalTreeRead = TREE): ILocalOrphanScope => ({ urls: [URL_OURS], socketPath: SOCKET, tree });

const owned: IOrphanOwnership = {
  tabs: new Map([
    ['tab-aaaa', { workspaceId: 'ws-test1', sessionName: 'pt-ws-test1-pane-p1-tab-aaaa', host: null }],
    ['tab-bbbb', { workspaceId: 'ws-test2', sessionName: 'pt-ws-test2-pane-p1-tab-bbbb', host: 'host-a' }],
  ]),
};

const fleet = (): Record<number, IFakeProc> => ({
  1: { ppid: 0, comm: 'init', uid: 0 },
  100: { ppid: 1, comm: 'tmux: server' },
  101: { ppid: 100, comm: 'bash', environ: ['PMUX_TAB_ID=tab-aaaa', tmuxEnv(101), `PMUX_TAB_TOKEN=${SECRET}`] },
  102: { ppid: 101, ...claude, environ: ['PMUX_TAB_ID=tab-aaaa', tmuxEnv(101), `PMUX_TAB_TOKEN=${SECRET}`] },
  // (ii) a second agent of tab-aaaa, re-parented away from its pane.
  110: { ppid: 1, ...claude, environ: ['PMUX_TAB_ID=tab-aaaa', tmuxEnv(101), `PMUX_TAB_TOKEN=${SECRET}`], cwd: '/work/a' },
  // (i) a job of a closed tab, re-parented.
  111: { ppid: 1, comm: 'sleep', environ: ['PMUX_TAB_ID=tab-gone', tmuxEnv(999), `PMUX_TAB_TOKEN=${SECRET}`] },
  // (iv) an unmarked agent with our PMUX_URL, re-parented.
  112: { ppid: 1, ...claude, environ: [`PMUX_URL=${URL_OURS}`, `SECRET_TOKEN=${SECRET}`, `HOME=/home/${SECRET}`], cwd: '/work/a' },
  // Not ours: another purplemux's tab on the same account (its own URL, its own socket).
  113: { ppid: 1, ...claude, environ: ['PMUX_TAB_ID=tab-other', 'PMUX_URL=http://localhost:9000', 'TMUX=/tmp/other/purple,5,0'] },
  // Not ours: an unmarked agent with neither our URL nor our tmux server.
  114: { ppid: 1, ...claude, environ: ['HOME=/h'] },
  // Another user's marked process: never read.
  115: { ppid: 1, uid: 0, comm: 'sleep', environ: ['PMUX_TAB_ID=tab-gone', tmuxEnv(1)] },
  // A pane of a session no layout owns, running an unmarked node agent.
  120: { ppid: 100, comm: 'bash', environ: ['HOME=/h'] },
  121: { ppid: 120, comm: 'node', argv: ['node', '/opt/lib/node_modules/@anthropic-ai/claude-code/cli.js'], environ: ['HOME=/h'] },
});

const collect = async (procs = fleet(), extra: Parameters<typeof fakeProc>[1] = {}, tree: TLocalTreeRead = TREE) => {
  const fake = fakeProc(procs, extra);
  const facts = await collectLocalOrphanFacts(fake.deps, scopeOf(tree));
  return { ...fake, facts: facts! };
};

const kindsOf = (entries: IOrphanEntry[]) =>
  entries.map((e) => (e.kind === 'unowned-session' ? `${e.kind}:${e.session.name}` : `${e.kind}:${e.process.pid}`)).sort();

const targetsOf = (entries: IOrphanEntry[]): IOrphanReapTarget[] =>
  entries.filter((e): e is IOrphanReapTarget['entry'] => e.kind === 'unowned-tab' || e.kind === 'duplicate-agent').map((entry) => ({ entry }));

describe('readEnvironMarks (the environ guard)', () => {
  it('keeps the tab id, compares PMUX_URL, and reads TMUX only for a marked process', () => {
    expect(readEnvironMarks(env('PMUX_TAB_ID=tab-aaaa', `TMUX=${SOCKET},1,0`, `PMUX_URL=${URL_OURS}`), [URL_OURS], SOCKET))
      .toEqual({ tabId: 'tab-aaaa', urlMatch: true, socketMatch: true });
    expect(readEnvironMarks(env(`TMUX=${SOCKET},1,0`, 'PMUX_URL=http://elsewhere:1'), [URL_OURS], SOCKET))
      .toEqual({ tabId: null, urlMatch: false, socketMatch: false });
    expect(readEnvironMarks(env('PMUX_TAB_ID=tab-aaaa', `TMUX=${SOCKET}x,1,0`), [URL_OURS], SOCKET).socketMatch).toBe(false);
    expect(readEnvironMarks(env('XPMUX_TAB_ID=tab-aaaa'), [URL_OURS], SOCKET).tabId).toBeNull();
  });

  it('a value that is no tab id reads as "?", never as the value', () => {
    expect(readEnvironMarks(env(`PMUX_TAB_ID=${SECRET} with spaces`), [], null).tabId).toBe('?');
  });
});

describe('collectLocalOrphanFacts and classifyOrphans (fake /proc)', () => {
  it('lists the four kinds, and only what this server started', async () => {
    const { facts } = await collect();
    expect(facts.tree).toEqual({ complete: true });
    expect(kindsOf(classifyOrphans(null, facts, owned))).toEqual([
      'duplicate-agent:110',
      'unmarked-agent:112',
      'unmarked-agent:121',
      'unowned-session:pt-ws-test1-pane-p2-tab-zzzz',
      'unowned-tab:111',
    ]);
  });

  it('an unmarked agent in a session no layout owns is listed; the one agent of an owned pane is its tab\'s', async () => {
    const { facts } = await collect();
    const ownsZ: IOrphanOwnership = {
      tabs: new Map([...owned.tabs, ['tab-zzzz', { workspaceId: 'ws-test1', sessionName: 'pt-ws-test1-pane-p2-tab-zzzz', host: null }]]),
    };
    const unmarked = facts.processes.find((p) => p.pid === 121)!;
    expect(unmarked).toMatchObject({ tabId: null, underServer: true, heldBy: 'pt-ws-test1-pane-p2-tab-zzzz', agent: true, agentAbove: false });
    expect(kindsOf(classifyOrphans(null, facts, owned))).toContain('unmarked-agent:121');
    expect(kindsOf(classifyOrphans(null, facts, ownsZ))).not.toContain('unmarked-agent:121');
    expect(kindsOf(classifyOrphans(null, facts, ownsZ))).not.toContain('unowned-session:pt-ws-test1-pane-p2-tab-zzzz');
  });

  it('an unmarked agent in a pane a layout owns that is not that pane\'s agent is listed, and never reaped', async () => {
    const procs = fleet();
    // In tab-aaaa's pane: its marked agent 102, an unmarked sibling agent 130, and 131, a sub-agent of 102.
    procs[130] = { ppid: 101, ...claude, environ: ['HOME=/h'], ageMs: 5 * MIN };
    procs[131] = { ppid: 102, ...claude, environ: ['HOME=/h'], ageMs: 2 * MIN };
    // In tab-zzzz's pane (a tab from before the marker, all unmarked): 121 is its agent; 140 a younger sibling.
    procs[140] = { ppid: 120, ...claude, environ: ['HOME=/h'], ageMs: MIN };
    const { facts } = await collect(procs);
    expect(facts.processes.find((p) => p.pid === 131)).toMatchObject({ agentAbove: true, heldBy: 'pt-ws-test1-pane-p1-tab-aaaa' });
    const ownsZ: IOrphanOwnership = {
      tabs: new Map([...owned.tabs, ['tab-zzzz', { workspaceId: 'ws-test1', sessionName: 'pt-ws-test1-pane-p2-tab-zzzz', host: null }]]),
    };
    const entries = classifyOrphans(null, facts, ownsZ);
    const unmarked = kindsOf(entries).filter((k) => k.startsWith('unmarked-agent'));
    expect(unmarked).toEqual(['unmarked-agent:112', 'unmarked-agent:130', 'unmarked-agent:140']);
    const sibling = entries.find((e) => e.kind === 'unmarked-agent' && e.process.pid === 130)!;
    expect(reapRefusal(sibling, facts.tree)).toBe('not-reapable');
  });

  it('the agent in its own tab\'s pane is no duplicate; a registered job of the tab is none either', async () => {
    const { facts } = await collect();
    expect(kindsOf(classifyOrphans(null, facts, owned))).not.toContain('duplicate-agent:102');
    expect(kindsOf(classifyOrphans(null, facts, { ...owned, registeredPids: new Set([110]) }))).not.toContain('duplicate-agent:110');
  });

  it('on another host every agent of a local tab is outside its pane', async () => {
    const { facts } = await collect();
    expect(kindsOf(classifyOrphans('host-a', facts, owned))).toContain('duplicate-agent:102');
  });

  it('never reads the server, its ancestors or descendants, or the tmux server', async () => {
    const { facts } = await collect(fleet(), { protectedPids: [110], serverDescendants: [111] });
    const pids = facts.processes.map((p) => p.pid);
    expect(pids).not.toContain(110);
    expect(pids).not.toContain(111);
    expect(pids).not.toContain(100);
    expect(pids).not.toContain(115);
  });

  it('no environ value but the tab id reaches the facts, the views or the JSON (planted secret)', async () => {
    const { facts } = await collect();
    const views = classifyOrphans(null, facts, owned).map(viewOrphan);
    for (const text of [JSON.stringify(facts), JSON.stringify(views)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(URL_OURS);
      expect(text).not.toContain(SOCKET);
      expect(text).not.toContain('--resume');
    }
  });

  it('an unmarked agent\'s view carries pid, ppid, comm, age and cwd only', async () => {
    const { facts } = await collect();
    const entry = classifyOrphans(null, facts, owned).find((e) => e.kind === 'unmarked-agent')!;
    expect(viewOrphan(entry)).toEqual({ kind: 'unmarked-agent', pid: 112, ppid: 1, comm: 'claude', ageS: 600, cwd: '/work/a' });
  });
});

describe('reapLocalOrphans', () => {
  const readable = async () => TREE;

  it('the duplicate case: only the agent outside the current pane tree is signalled; the agent in it stays', async () => {
    const { facts, deps, signals, alive } = await collect();
    const targets = targetsOf(classifyOrphans(null, facts, owned)).filter((t) => t.entry.kind === 'duplicate-agent');
    const outcomes = await reapLocalOrphans(deps, targets, facts.tree, readable);
    expect(outcomes).toEqual([{ pid: 110, comm: 'claude', tabId: 'tab-aaaa', kind: 'duplicate-agent', outcome: 'killed' }]);
    expect(alive.has(110)).toBe(false);
    expect(alive.has(102)).toBe(true);
    expect(signals.some((s) => s.endsWith(':102'))).toBe(false);
  });

  it('refuses a process a live pane holds, even when it reaches the reap', async () => {
    const { facts, deps, alive, signals } = await collect();
    const inTree = facts.processes.find((p) => p.pid === 102)!;
    const outcomes = await reapLocalOrphans(deps, [{ entry: { kind: 'duplicate-agent', process: inTree } }], facts.tree, readable);
    expect(outcomes).toEqual([{ pid: 102, comm: 'claude', tabId: 'tab-aaaa', kind: 'duplicate-agent', outcome: 'refused', refusal: 'held-by-session' }]);
    expect(alive.has(102)).toBe(true);
    expect(signals).toEqual([]);
  });

  it('reads the tree again before it signals: a target a pane holds now is refused', async () => {
    const { facts, deps, alive, signals } = await collect();
    const outside = facts.processes.find((p) => p.pid === 110)!;
    const nowHeld: TLocalTreeRead = { ...TREE, panes: [...TREE.panes, { session: 'pt-ws-test1-pane-p3-tab-aaaa', panePid: 110, ageMs: MIN }] };
    const outcomes = await reapLocalOrphans(deps, [{ entry: { kind: 'duplicate-agent', process: outside } }], facts.tree, async () => nowHeld);
    expect(outcomes[0]).toMatchObject({ pid: 110, outcome: 'refused', refusal: 'held-by-session' });
    expect(alive.has(110)).toBe(true);
    expect(signals).toEqual([]);
  });

  it('refuses an unmarked agent, a young process, a protected pid and a reused pid', async () => {
    const { facts, deps, alive, starts, signals } = await collect();
    const p = (pid: number) => facts.processes.find((f) => f.pid === pid)!;
    starts.set(111, 'start-reused');
    const young = { ...p(110), ageMs: ORPHAN_MIN_AGE_MS - 1 };
    const outcomes = await reapLocalOrphans(deps, [
      { entry: { kind: 'unmarked-agent', process: p(112) } },
      { entry: { kind: 'duplicate-agent', process: young } },
      { entry: { kind: 'unowned-tab', process: p(111) } },
      { entry: { kind: 'unowned-tab', process: { ...p(111), pid: 1 } } },
    ] as IOrphanReapTarget[], facts.tree, readable);
    expect(outcomes.map((o) => o.refusal)).toEqual(['not-reapable', 'too-young', 'identity-changed', 'protected']);
    expect(signals).toEqual([]);
    expect([110, 111, 112].every((pid) => alive.has(pid))).toBe(true);
  });

  it('a process that ignores SIGTERM is killed after the grace; the audit line names pid, comm, tab and kind only', async () => {
    const procs = fleet();
    procs[111].ignoresTerm = true;
    const { facts, deps, signals } = await collect(procs);
    const targets = targetsOf(classifyOrphans(null, facts, owned)).filter((t) => t.entry.kind === 'unowned-tab');
    const [outcome] = await reapLocalOrphans(deps, targets, facts.tree, readable);
    expect(outcome.outcome).toBe('killed');
    expect(signals).toEqual(['SIGTERM:111', 'SIGCONT:111', 'SIGKILL:111']);
    const audit = orphanReapAudit('local', outcome);
    expect(audit).toEqual({ event: 'tab-orphan-reap', host: 'local', pid: 111, comm: 'sleep', tabId: 'tab-gone', reason: 'unowned-tab', outcome: 'killed' });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });
});

describe('the reap fails closed when the pane tree is not read', () => {
  const seatSurvives = async (tree: TLocalTreeRead, killTimeTree: TLocalTreeRead = tree, extra: Parameters<typeof fakeProc>[1] = {}) => {
    const { facts, deps, alive, signals } = await collect(fleet(), extra, tree);
    const entries = classifyOrphans(null, facts, owned);
    const outcomes = await reapLocalOrphans(deps, targetsOf(entries), facts.tree, async () => killTimeTree);
    return { facts, entries, outcomes, alive, signals };
  };

  it('a tmux error: the live seat agent reads unheld, is listed, and every target is refused tree-unreadable', async () => {
    const { facts, entries, outcomes, alive, signals } = await seatSurvives({ readable: false, reason: 'tmux list-panes failed (exit 1: server exited unexpectedly)' });
    expect(facts.tree).toEqual({ complete: false, reason: 'tmux list-panes failed (exit 1: server exited unexpectedly)' });
    expect(kindsOf(entries)).toContain('duplicate-agent:102');
    expect(outcomes.find((o) => o.pid === 102)).toMatchObject({ outcome: 'refused', refusal: 'tree-unreadable' });
    expect(outcomes.every((o) => o.outcome === 'refused' && o.refusal === 'tree-unreadable')).toBe(true);
    expect(alive.has(102)).toBe(true);
    expect(signals).toEqual([]);
  });

  it('a timeout: the same, with the reason named', async () => {
    const { outcomes, alive, signals } = await seatSurvives({ readable: false, reason: 'tmux display-message timed out' });
    expect(outcomes.find((o) => o.pid === 102)?.refusal).toBe('tree-unreadable');
    expect(alive.has(102)).toBe(true);
    expect(signals).toEqual([]);
  });

  it('a tree read whole at the scan but not at the kill refuses every target', async () => {
    const { outcomes, alive, signals } = await seatSurvives(TREE, { readable: false, reason: 'tmux list-panes timed out' });
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.every((o) => o.refusal === 'tree-unreadable')).toBe(true);
    expect(alive.has(110)).toBe(true);
    expect(signals).toEqual([]);
  });

  it('a parent that cannot be read leaves that process unheld-unknown, and it is refused', async () => {
    const { facts, outcomes, alive } = await seatSurvives(TREE, TREE, { unreadableParents: [110] });
    expect(facts.processes.find((p) => p.pid === 110)).toMatchObject({ heldKnown: false });
    expect(outcomes.find((o) => o.pid === 110)).toMatchObject({ outcome: 'refused', refusal: 'tree-unreadable' });
    expect(alive.has(110)).toBe(true);
  });

  it('a process under the tmux server that no listed pane holds is refused: the pane list missed it', async () => {
    const tree: TLocalTreeRead = { readable: true, serverPid: 100, panes: [] };
    const { facts, outcomes, alive } = await seatSurvives(tree);
    expect(facts.processes.find((p) => p.pid === 102)).toMatchObject({ underServer: true, heldBy: null });
    expect(outcomes.find((o) => o.pid === 102)).toMatchObject({ refusal: 'tree-unreadable' });
    expect(alive.has(102)).toBe(true);
  });
});

describe('suspectForTab (the liveness guard)', () => {
  const T0 = 1_700_000_000_000;
  const suspect = (startedAt: number, cwd = '/work/shared', heldBy: string | null = null) => ({ pid: 4242, comm: 'claude', cwd, startedAt, heldBy });
  const peer = (tabId: string, launchedAt: number | null, cwd: string | null = '/work/shared'): ISuspectPeer =>
    ({ tabId, sessionName: `pt-ws-test1-pane-p-${tabId}`, cwd, launchedAt });

  it('two tabs share a cwd: one orphan makes at most the matching tab unknown', () => {
    const peers = [peer('tab-aaaa', T0), peer('tab-bbbb', T0 + 10 * MIN)];
    const orphan = suspect(T0 + 20 * MIN);
    expect(suspectForTab('tab-bbbb', peers, [orphan])).toEqual(orphan);
    expect(suspectForTab('tab-aaaa', peers, [orphan])).toBeNull();
    const between = suspect(T0 + 5 * MIN);
    expect(suspectForTab('tab-aaaa', peers, [between])).toEqual(between);
    expect(suspectForTab('tab-bbbb', peers, [between])).toBeNull();
  });

  it('a peer whose cwd is unknown is a possible match: the judged tab does not win a suspect that may be the peer\'s', () => {
    const unknownCwd = [peer('tab-aaaa', T0), peer('tab-cccc', T0 + 10 * MIN, null)];
    expect(suspectForTab('tab-aaaa', unknownCwd, [suspect(T0 + 20 * MIN)])).toBeNull();
    // Launched after the suspect started, the unknown-cwd peer cannot be its tab.
    expect(suspectForTab('tab-aaaa', unknownCwd, [suspect(T0 + 5 * MIN)])).not.toBeNull();
  });

  it('an orphan older than the tab\'s launch makes nothing unknown', () => {
    const peers = [peer('tab-aaaa', T0)];
    expect(suspectForTab('tab-aaaa', peers, [suspect(T0 - MIN)])).toBeNull();
    expect(suspectForTab('tab-aaaa', peers, [suspect(T0)])).toBeNull();
  });

  it('with no suspect the answer is absent (null)', () => {
    expect(suspectForTab('tab-aaaa', [peer('tab-aaaa', T0)], [])).toBeNull();
  });

  it('another cwd, another live pane, or a tab with no launch stamp or cwd is no match', () => {
    const peers = [peer('tab-aaaa', T0)];
    expect(suspectForTab('tab-aaaa', peers, [suspect(T0 + MIN, '/work/other')])).toBeNull();
    expect(suspectForTab('tab-aaaa', peers, [suspect(T0 + MIN, '/work/shared', 'pt-ws-test1-pane-p-tab-cccc')])).toBeNull();
    expect(suspectForTab('tab-aaaa', peers, [suspect(T0 + MIN, '/work/shared/', 'pt-ws-test1-pane-p-tab-aaaa')])).not.toBeNull();
    expect(suspectForTab('tab-aaaa', [peer('tab-aaaa', null)], [suspect(T0 + MIN)])).toBeNull();
    expect(suspectForTab('tab-aaaa', [peer('tab-aaaa', T0, null)], [suspect(T0 + MIN)])).toBeNull();
  });

  it('suspectsOf dates each unmarked agent from the given clock and keeps no marked process', async () => {
    const { facts } = await collect();
    expect(suspectsOf(facts, T0)).toEqual([
      { pid: 112, comm: 'claude', cwd: '/work/a', startedAt: T0 - 10 * MIN, heldBy: null },
      { pid: 121, comm: 'node', cwd: '/work/a', startedAt: T0 - 10 * MIN, heldBy: 'pt-ws-test1-pane-p2-tab-zzzz' },
    ]);
  });
});
