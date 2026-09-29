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

describe.skipIf(!isLinux)('the pgrep fallback when the kernel exposes no children lists', () => {
  // CONFIG_PROC_CHILDREN off: every /proc/<pid>/task/<tid>/children read fails while the process
  // exists. readProcChildren must answer null (not []), and both walks must fall back to pgrep:
  // an empty list here would silently hide every child, the bug the old tmux reader had.
  const mockNoChildrenFiles = (pgrepOut: string) => {
    const execFile = vi.fn((...args: unknown[]) => {
      const callback = args[args.length - 1];
      // promisify() of a plain function resolves with this one value; the code reads `.stdout`.
      if (typeof callback === 'function') callback(null, { stdout: pgrepOut, stderr: '' });
    });
    vi.doMock('child_process', async (original) => ({ ...(await original<typeof import('child_process')>()), execFile }));
    vi.doMock('fs/promises', async (original) => {
      const real = await original<typeof import('fs/promises')>();
      const readFile = (async (file: Parameters<typeof real.readFile>[0], ...rest: unknown[]) => {
        if (String(file).endsWith('/children')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return (real.readFile as (...a: unknown[]) => unknown)(file, ...rest);
      }) as typeof real.readFile;
      return { ...real, default: { ...real, readFile }, readFile };
    });
    vi.resetModules();
    return execFile;
  };

  it('readProcChildren answers null and getChildPids uses pgrep', async () => {
    const execFile = mockNoChildrenFiles('41\n42\n');
    const { getChildPids, readProcChildren } = await import('@/lib/process-utils');

    expect(await readProcChildren(process.pid)).toBeNull();
    expect(await getChildPids(process.pid)).toEqual([41, 42]);
    expect(execFile).toHaveBeenCalledWith('pgrep', ['-P', String(process.pid)], expect.any(Function));
  });

  it('getDescendantPids (tmux) uses pgrep for the frontier', async () => {
    const execFile = mockNoChildrenFiles('');
    const { getDescendantPids } = await import('@/lib/tmux');

    await getDescendantPids(process.pid);

    expect(execFile.mock.calls.some(([cmd, args]) => cmd === 'pgrep' && (args as string[])[0] === '-P')).toBe(true);
  });
});
