import { spawn, spawnSync } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The Codex hook's process proof walks the pane's process tree with getChildPids, one call per
// node, under the tab's lock. It spawned `pgrep -P` per node: measured 2026-09-29 on this host
// (load ~140), a walk of the tmux tree (437 nodes) took 80.6 s with pgrep and 68 ms reading
// /proc/<pid>/task/*/children, and live Codex hook POSTs were held 26-50 s server-side.
//
// On Linux the children come from the kernel's per-thread lists, unioned over every thread: a
// child belongs to the thread that forked it, so the main thread's list alone misses a child a
// worker thread started.

const isLinux = process.platform === 'linux';
const children: { kill: (signal?: NodeJS.Signals) => boolean }[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  vi.restoreAllMocks();
  vi.doUnmock('child_process');
  vi.resetModules();
});

const pgrepChildren = (pid: number): number[] => {
  const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8' });
  return r.stdout.trim().split('\n').filter(Boolean).map(Number).sort((a, b) => a - b);
};

const waitFor = async (until: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!until() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
};

describe.skipIf(!isLinux)('getChildPids on Linux', () => {
  it('returns the same children as pgrep -P, ascending', async () => {
    const parent = spawn('bash', ['-c', 'sleep 30 & sleep 30 & sleep 30 & wait'], { stdio: 'ignore' });
    children.push(parent);
    await waitFor(() => pgrepChildren(parent.pid!).length === 3);
    const { getChildPids } = await import('@/lib/process-utils');

    const kids = await getChildPids(parent.pid!);

    expect(kids).toHaveLength(3);
    expect(kids).toEqual(pgrepChildren(parent.pid!));
  }, 30_000);

  it('includes a child forked by a worker thread, not only the main thread', async () => {
    // A node parent whose Worker spawns the child: the fork happens on the worker's thread.
    const script = [
      "const { Worker } = require('worker_threads');",
      "new Worker(\"require('child_process').spawn('sleep', ['30'], { stdio: 'ignore' }); setInterval(() => {}, 1000);\", { eval: true });",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const parent = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    children.push(parent);
    await waitFor(() => pgrepChildren(parent.pid!).length === 1);
    const expected = pgrepChildren(parent.pid!);
    expect(expected).toHaveLength(1);
    const { getChildPids } = await import('@/lib/process-utils');

    expect(await getChildPids(parent.pid!)).toEqual(expected);
  }, 30_000);

  it('spawns no process: the tree walk is file reads only', async () => {
    const parent = spawn('bash', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    children.push(parent);
    await waitFor(() => pgrepChildren(parent.pid!).length === 1);
    // Answers at once (as a failed spawn), so a regression fails on the assertion, not a timeout.
    const execFile = vi.fn((...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') callback(new Error('spawned'), '', '');
    });
    vi.doMock('child_process', async (original) => ({ ...(await original<typeof import('child_process')>()), execFile }));
    vi.resetModules();
    const { getChildPids } = await import('@/lib/process-utils');

    expect(await getChildPids(parent.pid!)).toHaveLength(1);
    expect(execFile).not.toHaveBeenCalled();
  }, 30_000);

  it('a process that is gone has no children', async () => {
    const { getChildPids } = await import('@/lib/process-utils');
    const gone = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf-8' });

    expect(await getChildPids(Number(gone.stdout.trim()))).toEqual([]);
  });
});

describe.skipIf(!isLinux)('getDescendantPids (tmux) uses the same per-thread union', () => {
  it('includes a child forked by a worker thread', async () => {
    const script = [
      "const { Worker } = require('worker_threads');",
      "new Worker(\"require('child_process').spawn('sleep', ['30'], { stdio: 'ignore' }); setInterval(() => {}, 1000);\", { eval: true });",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const parent = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    children.push(parent);
    await waitFor(() => pgrepChildren(parent.pid!).length === 1);
    const [sleeper] = pgrepChildren(parent.pid!);
    expect(sleeper, 'the worker thread never forked its child').toBeDefined();
    const { getDescendantPids } = await import('@/lib/tmux');

    expect(await getDescendantPids(parent.pid!)).toContain(sleeper);
  }, 30_000);
});
