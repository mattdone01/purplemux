import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import pathMod from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORPHAN_TREE_BOUND, REMOTE_ORPHAN_REAP_SCRIPT, REMOTE_ORPHAN_SCAN_SCRIPT, parseRemoteOrphanReap, parseRemoteOrphanScan } from '@/lib/remote-host';
import { classifyOrphans, type IOrphanEntry, type IOrphanHostFacts, type IOrphanOwnership } from '@/lib/tab-orphans';

// The remote orphan scan and reap, run for real on this host's sh and tmux against a throwaway socket, as the
// remote host runs them over `ssh … sh -s`. The scan reports facts only; `classifyOrphans` judges them with the
// rules the local scan uses.

const execAsync = promisify(execFile);
// tmux and every pane start from a clean environment: a test run inside a tab must not lend its own marker to them.
const CLEAN_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' };
const run = (cmd: string, args: string[]) => execAsync(cmd, args, { env: CLEAN_ENV });

const hasTool = (cmd: string): boolean => {
  try {
    execFileSync(cmd, ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const supported = process.platform === 'linux' && hasTool('tmux');

const runScript = (script: string, args: string[], opts: { env?: NodeJS.ProcessEnv; killAfterMs?: number } = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('sh', ['-s', '--', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? CLEAN_ENV, detached: true });
    let out = '';
    const timer = opts.killAfterMs ? setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }, opts.killAfterMs) : null;
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => { if (timer) clearTimeout(timer); resolve(out); });
    child.stdin.end(script);
  });

/** A stand-in tmux first on PATH: the scripts' only tmux. */
const withFakeTmux = (body: string): { env: NodeJS.ProcessEnv; dir: string } => {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'pmux-fake-tmux-'));
  fs.writeFileSync(pathMod.join(dir, 'tmux'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { env: { ...CLEAN_ENV, PATH: `${dir}:${CLEAN_ENV.PATH}` }, dir };
};

const factsOf = (stdout: string): IOrphanHostFacts => {
  const facts = parseRemoteOrphanScan(stdout);
  if (!facts || facts === 'unavailable') throw new Error(`no facts: ${stdout}`);
  return facts;
};

const SECRET = `planted-secret-${randomBytes(4).toString('hex')}`;
const AGENT_LOOP = 'exec -a claude bash -c "while :; do sleep 1; done"';

const startOf = (pid: number): string => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
};
const isAlive = (pid: number): boolean => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
  } catch {
    return false;
  }
};

describe.skipIf(!supported)('remote orphan scripts, run for real', { timeout: 30_000 }, () => {
  const id = randomBytes(4).toString('hex');
  const sock = `pmux-orphtest-${process.pid}-${id}`;
  const url = `http://origin-test-${id}:8022`;
  const owned = `tab-orphtest${id}a`;
  const gone = `tab-orphtest${id}g`;
  const ownedSession = `pt-ws-test1-pane-p1-${owned}`;
  const strayedSession = `pt-ws-test1-pane-p2-tab-orphtest${id}z`;
  const children: ChildProcess[] = [];

  afterEach(async () => {
    await run('tmux', ['-L', sock, 'kill-server']).catch(() => {});
    for (const child of children.splice(0)) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  const detached = (env: Record<string, string>, script: string): number => {
    const child = spawn('bash', ['-c', script], { detached: true, stdio: 'ignore', env: { ...CLEAN_ENV, ...env } });
    children.push(child);
    return child.pid!;
  };

  const paneChild = async (session: string): Promise<number> => {
    let found = 0;
    await vi.waitFor(async () => {
      const { stdout } = await run('tmux', ['-L', sock, 'display-message', '-p', '-t', `=${session}:`, '#{pane_pid}']);
      const pane = stdout.trim();
      const kids = fs.readFileSync(`/proc/${pane}/task/${pane}/children`, 'utf-8').trim().split(/\s+/).filter(Boolean);
      const agent = [...kids, pane].find((pid) => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0')[0] === 'claude');
      expect(agent).toBeDefined();
      found = Number(agent);
    }, { timeout: 10_000, interval: 50 });
    return found;
  };

  const start = async () => {
    await run('tmux', ['-L', sock, '-f', '/dev/null', 'new-session', '-d', '-s', ownedSession, '-x', '80', '-y', '24',
      `env PMUX_TAB_ID=${owned} PMUX_URL=${url} PMUX_TAB_TOKEN=${SECRET} bash -c '${AGENT_LOOP}'`]);
    await run('tmux', ['-L', sock, '-f', '/dev/null', 'new-session', '-d', '-s', strayedSession, '-x', '80', '-y', '24', 'exec sleep 300']);
    const inPane = await paneChild(ownedSession);
    const duplicate = detached({ PMUX_TAB_ID: owned, PMUX_URL: url, PMUX_TAB_TOKEN: SECRET }, AGENT_LOOP);
    const closedTabJob = detached({ PMUX_TAB_ID: gone, PMUX_URL: url, PMUX_TAB_TOKEN: SECRET }, 'exec sleep 300');
    const unmarked = detached({ PMUX_URL: url, OTHER_TOKEN: SECRET }, AGENT_LOOP);
    const foreign = detached({ PMUX_TAB_ID: gone, PMUX_URL: 'http://another-server:9000' }, AGENT_LOOP);
    await vi.waitFor(() => {
      for (const pid of [duplicate, unmarked, foreign]) expect(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0')[0]).toBe('claude');
      expect(fs.readFileSync(`/proc/${closedTabJob}/comm`, 'utf-8').trim()).toBe('sleep');
    }, { timeout: 10_000, interval: 50 });
    return { inPane, duplicate, closedTabJob, unmarked, foreign };
  };

  const ownership: IOrphanOwnership = {
    tabs: new Map([[owned, { workspaceId: 'ws-test1', sessionName: ownedSession, host: 'host-a' }]]),
  };

  const label = (e: IOrphanEntry) => (e.kind === 'unowned-session' ? `${e.kind}:${e.session.name}` : `${e.kind}:${e.process.pid}`);

  it('reports the four kinds with the local rules, and only what this server started', async () => {
    const pids = await start();
    const stdout = await runScript(REMOTE_ORPHAN_SCAN_SCRIPT, [sock, url]);
    const facts = factsOf(stdout);
    expect(facts.tree).toEqual({ complete: true });
    const entries = classifyOrphans('host-a', facts, ownership).map(label).sort();
    expect(entries).toEqual([
      `duplicate-agent:${pids.duplicate}`,
      `unmarked-agent:${pids.unmarked}`,
      `unowned-session:${strayedSession}`,
      `unowned-tab:${pids.closedTabJob}`,
    ].sort());
    const inPane = facts!.processes.find((p) => p.pid === pids.inPane);
    expect(inPane).toMatchObject({ tabId: owned, agent: true, underServer: true, heldBy: ownedSession, urlMatch: true, socketMatch: true });
    expect(facts!.processes.some((p) => p.pid === pids.foreign)).toBe(false);
    const unmarked = facts!.processes.find((p) => p.pid === pids.unmarked)!;
    expect(unmarked).toMatchObject({ tabId: null, urlMatch: true, underServer: false, heldBy: null, agent: true });
    expect(unmarked.ageMs).toBeGreaterThanOrEqual(0);
    expect(unmarked.ageMs).toBeLessThan(60_000);
    expect(unmarked.cwd).toBe(process.cwd());
  });

  it('prints no environ value but the tab id, and no argv (planted secret)', async () => {
    await start();
    const stdout = await runScript(REMOTE_ORPHAN_SCAN_SCRIPT, [sock, url]);
    expect(stdout).toContain(`=${owned}`);
    expect(stdout).not.toContain(SECRET);
    expect(stdout).not.toContain(url);
    expect(stdout).not.toContain('while :');
  });

  it('the reap signals the duplicate outside the pane, refuses the agent the pane holds, and leaves a reused pid', async () => {
    const pids = await start();
    const stdout = await runScript(REMOTE_ORPHAN_REAP_SCRIPT, [
      sock,
      `${pids.duplicate}:${startOf(pids.duplicate)}`,
      `${pids.inPane}:${startOf(pids.inPane)}`,
      `${pids.closedTabJob}:1`,
      '1:1',
    ]);
    const reap = parseRemoteOrphanReap(stdout);
    expect(reap).toEqual({
      killed: [pids.duplicate],
      survivors: [],
      refused: [
        { pid: pids.inPane, refusal: 'held-by-session' },
        { pid: pids.closedTabJob, refusal: 'identity-changed' },
        { pid: 1, refusal: 'protected' },
      ],
    });
    await vi.waitFor(() => expect(isAlive(pids.duplicate)).toBe(false), { timeout: 5_000, interval: 50 });
    expect(isAlive(pids.inPane)).toBe(true);
    expect(isAlive(pids.closedTabJob)).toBe(true);
  });

  it('a run cut short reads as no answer, never as an empty host', () => {
    expect(parseRemoteOrphanScan('session\t1000\tpt-x\n')).toBeNull();
    expect(parseRemoteOrphanReap('killed\t12\n')).toBeNull();
    expect(parseRemoteOrphanScan('end\n')).toEqual({ tree: { complete: false, reason: 'the scan reported no tree' }, sessions: [], processes: [] });
  });

  it('a pane a layout owns: its agent and that agent\'s sub-agent stay off the list; a sibling agent is listed, never reaped', async () => {
    // A tab from before the marker: everything in its pane is unmarked. The pane's shell starts agent A (with a
    // sub-agent) and, half a second later, agent B.
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'pmux-pane-agents-'));
    try {
      fs.writeFileSync(pathMod.join(dir, 'loop.sh'), 'while :; do sleep 1; done\n');
      fs.writeFileSync(pathMod.join(dir, 'parent.sh'), `(exec -a claude bash ${dir}/loop.sh) &\nwhile :; do sleep 1; done\n`);
      fs.writeFileSync(pathMod.join(dir, 'pane.sh'),
        `bash -c 'exec -a claude bash ${dir}/parent.sh' &\nsleep 0.5\nbash -c 'exec -a claude bash ${dir}/loop.sh' &\nwait\n`);
      await run('tmux', ['-L', sock, '-f', '/dev/null', 'new-session', '-d', '-s', ownedSession, '-x', '80', '-y', '24', `bash ${dir}/pane.sh`]);
      let facts: IOrphanHostFacts | null = null;
      await vi.waitFor(async () => {
        facts = factsOf(await runScript(REMOTE_ORPHAN_SCAN_SCRIPT, [sock, url]));
        expect(facts.processes.filter((p) => p.agent && p.heldBy === ownedSession)).toHaveLength(3);
      }, { timeout: 10_000, interval: 200 });
      const agents = facts!.processes.filter((p) => p.agent).sort((a, b) => b.ageMs - a.ageMs || a.pid - b.pid);
      const sub = agents.find((p) => p.agentAbove)!;
      const tops = agents.filter((p) => !p.agentAbove);
      expect(tops).toHaveLength(2);
      const [paneAgent, sibling] = tops;
      const entries = classifyOrphans('host-a', facts!, ownership);
      expect(entries.filter((e) => e.kind === 'unmarked-agent').map(label)).toEqual([`unmarked-agent:${sibling.pid}`]);
      expect(entries.map(label)).not.toContain(`unmarked-agent:${paneAgent.pid}`);
      expect(entries.map(label)).not.toContain(`unmarked-agent:${sub.pid}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!supported)('remote orphan scripts fail closed when the pane tree is not read', { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    for (const child of children.splice(0)) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  /** A live process the reap must leave alone: a seat's agent the broken read could not see. */
  const seat = async (): Promise<number> => {
    const child = spawn('bash', ['-c', AGENT_LOOP], { detached: true, stdio: 'ignore', env: CLEAN_ENV });
    children.push(child);
    await vi.waitFor(() => expect(fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf-8').split('\0')[0]).toBe('claude'), { timeout: 5_000, interval: 50 });
    return child.pid!;
  };

  const fakeTmux = (body: string) => {
    const fake = withFakeTmux(body);
    dirs.push(fake.dir);
    return fake.env;
  };

  const reapRefuses = async (script: string, env: NodeJS.ProcessEnv) => {
    const pid = await seat();
    const reap = parseRemoteOrphanReap(await runScript(script, ['sock', `${pid}:${startOf(pid)}`], { env }));
    expect(reap).toEqual({ killed: [], survivors: [], refused: [{ pid, refusal: 'tree-unreadable' }] });
    expect(isAlive(pid)).toBe(true);
  };

  it('a tmux error: the scan says the tree is unreadable, and the reap refuses every target', async () => {
    const env = fakeTmux("echo 'server exited unexpectedly' >&2; exit 1");
    expect(factsOf(await runScript(REMOTE_ORPHAN_SCAN_SCRIPT, ['sock', 'http://origin-test:1'], { env })).tree)
      .toEqual({ complete: false, reason: 'tmux failed' });
    await reapRefuses(REMOTE_ORPHAN_REAP_SCRIPT, env);
  });

  it('tmux\'s own "no server running" is a complete, empty tree', async () => {
    const env = fakeTmux("echo 'no server running on /tmp/tmux-1000/sock' >&2; exit 1");
    const facts = factsOf(await runScript(REMOTE_ORPHAN_SCAN_SCRIPT, ['sock', 'http://origin-test:1'], { env }));
    expect(facts.tree).toEqual({ complete: true });
    expect(facts.sessions).toEqual([]);
  });

  it('a tmux that hangs: the run is cut off, reads as no answer, and the seat survives', async () => {
    const env = fakeTmux('sleep 30');
    const pid = await seat();
    expect(parseRemoteOrphanScan(await runScript(REMOTE_ORPHAN_SCAN_SCRIPT, ['sock', 'http://origin-test:1'], { env, killAfterMs: 1_000 }))).toBeNull();
    expect(parseRemoteOrphanReap(await runScript(REMOTE_ORPHAN_REAP_SCRIPT, ['sock', `${pid}:${startOf(pid)}`], { env, killAfterMs: 1_000 }))).toBeNull();
    expect(isAlive(pid)).toBe(true);
  });

  it('no children files (a kernel without CONFIG_PROC_CHILDREN): the tree is unreadable and nothing is reaped', async () => {
    // A stand-in process table: the tmux server's stat is there, its task children file is not.
    const table = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'pmux-fake-proc-'));
    dirs.push(table);
    for (const pid of ['self', '4242', '4243']) {
      fs.mkdirSync(pathMod.join(table, pid, 'task', pid), { recursive: true });
      fs.writeFileSync(pathMod.join(table, pid, 'stat'), `${pid} (x) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0\n`);
    }
    fs.writeFileSync(pathMod.join(table, 'uptime'), '1000.00 1000.00\n');
    const env = fakeTmux(`case "$*" in *socket_path*) echo /tmp/none ;; *display-message*) echo 4242 ;; *list-panes*) echo '4243 1700000000 pt-ws-test1-pane-p1-tab-aaaa' ;; esac`);
    const scan = REMOTE_ORPHAN_SCAN_SCRIPT.replaceAll('/proc/', `${table}/`);
    expect(factsOf(await runScript(scan, ['sock', 'http://origin-test:1'], { env })).tree)
      .toEqual({ complete: false, reason: 'process table unreadable' });
    await reapRefuses(REMOTE_ORPHAN_REAP_SCRIPT.replaceAll('/proc/', `${table}/`), env);
  });

  it('the walk\'s bound hit: the tree is unreadable and the seat agent in a real pane survives', async () => {
    const sock = `pmux-orphbound-${process.pid}-${randomBytes(3).toString('hex')}`;
    try {
      await run('tmux', ['-L', sock, '-f', '/dev/null', 'new-session', '-d', '-s', 'pt-ws-test1-pane-p1-tab-aaaa', '-x', '80', '-y', '24', `bash -c '${AGENT_LOOP}'`]);
      const bound = (script: string) => script.replace(`-gt ${ORPHAN_TREE_BOUND} ]`, '-gt 0 ]');
      expect(bound(REMOTE_ORPHAN_SCAN_SCRIPT)).not.toBe(REMOTE_ORPHAN_SCAN_SCRIPT);
      const facts = factsOf(await runScript(bound(REMOTE_ORPHAN_SCAN_SCRIPT), [sock, 'http://origin-test:1']));
      expect(facts.tree).toEqual({ complete: false, reason: 'process inventory bound exceeded' });
      const { stdout } = await run('tmux', ['-L', sock, 'display-message', '-p', '-t', '=pt-ws-test1-pane-p1-tab-aaaa:', '#{pane_pid}']);
      const pane = Number(stdout.trim());
      const reap = parseRemoteOrphanReap(await runScript(bound(REMOTE_ORPHAN_REAP_SCRIPT), [sock, `${pane}:${startOf(pane)}`]));
      expect(reap).toEqual({ killed: [], survivors: [], refused: [{ pid: pane, refusal: 'tree-unreadable' }] });
      expect(isAlive(pane)).toBe(true);
    } finally {
      await run('tmux', ['-L', sock, 'kill-server']).catch(() => {});
    }
  });

  it('a host without /proc answers unavailable, never ok with no orphans', async () => {
    const scan = REMOTE_ORPHAN_SCAN_SCRIPT.replaceAll('/proc/', '/nonexistent-proc-table/');
    expect(parseRemoteOrphanScan(await runScript(scan, ['sock', 'http://origin-test:1']))).toBe('unavailable');
  });
});
