import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultReaperDeps, environHasTabId, reapTabProcesses, REAP_GRACE_MS, type ITabReaperDeps } from '@/lib/tab-reaper';
import { getDescendantPids } from '@/lib/tmux';

const env = (...entries: string[]) => Buffer.from(entries.join('\0') + '\0');

describe('environHasTabId', () => {
  it('matches the exact entry only', () => {
    expect(environHasTabId(env('HOME=/h', 'PMUX_TAB_ID=tab-ab'), 'tab-ab')).toBe(true);
    expect(environHasTabId(env('PMUX_TAB_ID=tab-abc'), 'tab-ab')).toBe(false);
    expect(environHasTabId(env('PMUX_TAB_ID=tab-a'), 'tab-ab')).toBe(false);
    expect(environHasTabId(env('XPMUX_TAB_ID=tab-ab'), 'tab-ab')).toBe(false);
    expect(environHasTabId(env('NOTE=PMUX_TAB_ID=tab-ab'), 'tab-ab')).toBe(false);
  });
});

describe('reapTabProcesses (fake /proc)', () => {
  const fake = (opts: {
    procs: Record<number, { environ?: string[]; uid?: number; pgid?: number; ignoresTerm?: boolean }>;
    descendants?: number[];
    proc?: boolean;
  }) => {
    const alive = new Set(Object.keys(opts.procs).map(Number));
    let clock = 0;
    const signals: string[] = [];
    const deps: ITabReaperDeps = {
      procAvailable: async () => opts.proc ?? true,
      listPids: async () => [...alive],
      readEnviron: async (pid) => (alive.has(pid) && opts.procs[pid]?.environ ? env(...opts.procs[pid].environ!) : null),
      ownerUid: async (pid) => (alive.has(pid) ? opts.procs[pid]?.uid ?? 1000 : null),
      describe: async (pid) => ({ pid, comm: `p${pid}`, args: `cmd ${pid}` }),
      descendants: async () => opts.descendants ?? [],
      processGroup: async (pid) => opts.procs[pid]?.pgid ?? pid,
      isAlive: (pid) => alive.has(pid),
      kill: (pid, sig) => {
        signals.push(`${sig}:${pid}`);
        if (sig === 'SIGKILL' || !opts.procs[pid]?.ignoresTerm) alive.delete(pid);
      },
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      selfPid: 1,
      uid: 1000,
    };
    return { deps, signals, alive };
  };

  it('SIGTERMs descendants and marked processes, SIGKILLs a survivor after the grace, and reports both', async () => {
    const { deps, signals } = fake({
      procs: {
        1: { environ: ['PMUX_TAB_ID=tab-t'] }, // the server itself: never touched
        10: { environ: ['PMUX_TAB_ID=tab-t'] }, // the pane shell: goes with the session
        11: {}, // a pane descendant without the marker (pre-story-01 child)
        20: { environ: ['PMUX_TAB_ID=tab-t'] }, // setsid'd, re-parented away
        21: { environ: ['PMUX_TAB_ID=tab-t'], ignoresTerm: true },
        30: { environ: ['PMUX_TAB_ID=tab-tx'] }, // another tab whose id extends this one
        40: { environ: ['PMUX_TAB_ID=tab-t'], uid: 0 }, // another user's process
      },
      descendants: [11],
    });
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: 10 });
    expect(result.reaper).toBe('linux');
    expect(result.envMarker).toBe('present');
    expect(result.killed.map((p) => p.pid).sort()).toEqual([11, 20, 21]);
    expect(result.survivors).toEqual([]);
    expect(signals).toContain('SIGKILL:21');
    expect(signals.some((s) => /:(1|10|30|40)$/.test(s))).toBe(false);
  });

  it('keepProcesses signals only the pane group and skips the marker scan', async () => {
    const { deps } = fake({
      procs: { 10: { environ: ['PMUX_TAB_ID=tab-t'] }, 11: { pgid: 10 }, 12: { pgid: 12 }, 20: { environ: ['PMUX_TAB_ID=tab-t'] } },
      descendants: [11, 12],
    });
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: 10, keepProcesses: true });
    expect(result.killed.map((p) => p.pid)).toEqual([11]);
  });

  it('says envMarker absent for a tab created before per-tab identity, and still reaps its descendants', async () => {
    const { deps } = fake({ procs: { 10: { environ: ['HOME=/h'] }, 11: {} }, descendants: [11] });
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: 10 });
    expect(result).toMatchObject({ envMarker: 'absent', killed: [{ pid: 11 }] });
  });

  it('reports reaper unavailable without /proc and touches nothing', async () => {
    const { deps, signals } = fake({ procs: { 11: {} }, descendants: [11], proc: false });
    expect(await reapTabProcesses(deps, { tabId: 'tab-t', panePid: 10 })).toEqual({ reaper: 'unavailable', envMarker: 'unknown', killed: [], survivors: [] });
    expect(signals).toEqual([]);
  });

  it('lists a process that survives even SIGKILL as a survivor', async () => {
    const { deps } = fake({ procs: { 20: { environ: ['PMUX_TAB_ID=tab-t'] } } });
    deps.kill = () => {};
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: null });
    expect(result.survivors.map((p) => p.pid)).toEqual([20]);
  });
});

// Real processes. Each test uses a random tab id, so the exact-match scan can
// only ever find the sleeps this test started.
describe.runIf(process.platform === 'linux')('reapTabProcesses (real processes, Linux)', () => {
  const started: number[] = [];
  const children: ChildProcess[] = [];
  // Cleanup kills ONLY real pids this test started: never 0 or negative, which
  // would signal the test runner's own process group.
  const killStarted = (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 1) return;
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  };
  afterEach(() => {
    for (const pid of started.splice(0)) killStarted(pid);
    for (const child of children.splice(0)) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  });

  const tabId = () => `tab-reap${Math.random().toString(36).slice(2, 10)}`;
  const pidsFile = () => `/tmp/pmux-reap-${process.pid}-${Math.random().toString(36).slice(2)}`;

  /** A "pane": a detached bash (own process group) with the tab marker, starting the given jobs. */
  const pane = async (id: string | null, script: string): Promise<{ panePid: number; pids: Record<string, number> }> => {
    const file = pidsFile();
    const child = spawn('bash', ['-c', `${script}\nwait`], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...(id ? { PMUX_TAB_ID: id } : {}), PIDS_FILE: file },
    });
    children.push(child);
    started.push(child.pid!);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8').split('\n').includes('ready')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const pids: Record<string, number> = {};
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      const match = line.match(/^([a-z-]+) (\d+)$/);
      if (!match || Number(match[2]) <= 1) continue;
      pids[match[1]] = Number(match[2]);
      started.push(Number(match[2]));
    }
    fs.rmSync(file, { force: true });
    return { panePid: child.pid!, pids };
  };

  const alive = (pid: number) => {
    try {
      const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8').split(') ')[1][0];
      return state !== 'Z';
    } catch {
      return false;
    }
  };

  const JOBS = [
    '( sleep 600 & echo "disowned $!" >> "$PIDS_FILE"; disown )',
    'setsid nohup sleep 600 >/dev/null 2>&1 & echo "setsid $!" >> "$PIDS_FILE"',
    'bash -c \'trap "" TERM; while :; do sleep 1; done\' & echo "ignores-term $!" >> "$PIDS_FILE"',
    'echo ready >> "$PIDS_FILE"',
  ].join('\n');

  it('reaps disowned, setsid-nohup and SIGTERM-ignoring children within 4 s; another tab with a longer id survives', { timeout: 15_000 }, async () => {
    const id = tabId();
    const mine = await pane(id, JOBS);
    const other = await pane(`${id}x`, 'sleep 600 & echo "other $!" >> "$PIDS_FILE"\necho ready >> "$PIDS_FILE"');
    const t0 = Date.now();
    const result = await reapTabProcesses(defaultReaperDeps(getDescendantPids), { tabId: id, panePid: mine.panePid });
    expect(Date.now() - t0).toBeLessThan(REAP_GRACE_MS + 1000);
    const killed = result.killed.map((p) => p.pid);
    for (const name of ['disowned', 'setsid', 'ignores-term']) {
      expect(killed).toContain(mine.pids[name]);
      expect(alive(mine.pids[name])).toBe(false);
    }
    expect(result.envMarker).toBe('present');
    expect(result.survivors).toEqual([]);
    expect(alive(other.pids.other)).toBe(true);
  });

  it('keepProcesses: the setsid child survives and only the pane group is killed', { timeout: 15_000 }, async () => {
    const id = tabId();
    const mine = await pane(id, 'sleep 600 & echo "group $!" >> "$PIDS_FILE"\nsetsid nohup sleep 600 >/dev/null 2>&1 & echo "setsid $!" >> "$PIDS_FILE"\necho ready >> "$PIDS_FILE"');
    const result = await reapTabProcesses(defaultReaperDeps(getDescendantPids), { tabId: id, panePid: mine.panePid, keepProcesses: true });
    const killed = result.killed.map((p) => p.pid);
    expect(killed).toContain(mine.pids.group);
    expect(killed).not.toContain(mine.pids.setsid);
    expect(alive(mine.pids.setsid)).toBe(true);
  });

  it('a pane without the marker (created before per-tab identity) still has its descendants reaped', { timeout: 15_000 }, async () => {
    const mine = await pane(null, 'sleep 600 & echo "child $!" >> "$PIDS_FILE"\necho ready >> "$PIDS_FILE"');
    const result = await reapTabProcesses(defaultReaperDeps(getDescendantPids), { tabId: tabId(), panePid: mine.panePid });
    expect(result.envMarker).toBe('absent');
    expect(result.killed.map((p) => p.pid)).toContain(mine.pids.child);
    expect(alive(mine.pids.child)).toBe(false);
  });
});
