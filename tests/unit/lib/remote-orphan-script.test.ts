import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_ORPHAN_REAP_SCRIPT, REMOTE_ORPHAN_SCAN_SCRIPT, parseRemoteOrphanReap, parseRemoteOrphanScan } from '@/lib/remote-host';
import { classifyOrphans, type IOrphanEntry, type IOrphanOwnership } from '@/lib/tab-orphans';

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

const runScript = (script: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('sh', ['-s', '--', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: CLEAN_ENV });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(script);
  });

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
    const facts = parseRemoteOrphanScan(stdout);
    expect(facts).not.toBeNull();
    const entries = classifyOrphans('host-a', facts!, ownership).map(label).sort();
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
    expect(parseRemoteOrphanScan('end\n')).toEqual({ sessions: [], processes: [] });
  });
});
