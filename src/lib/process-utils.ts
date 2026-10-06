import fs from 'fs/promises';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { isLinux } from '@/lib/platform';

const execFile = promisify(execFileCb);

export const isProcessRunning = (pid: number): Promise<boolean> =>
  new Promise((resolve) => {
    execFileCb('ps', ['-p', String(pid)], (err) => {
      resolve(!err);
    });
  });

/**
 * A process's children from the kernel, without spawning a process: each thread's
 * `/proc/<pid>/task/<tid>/children`, unioned, because a child belongs to the thread that forked
 * it (a Codex or node parent forks from worker threads). Ascending, like `pgrep -P`. `[]` for a
 * process that is gone; `null` when the kernel exposes no children lists (CONFIG_PROC_CHILDREN
 * off), so the caller falls back to `pgrep`.
 *
 * Measured 2026-09-29 (load ~140): a walk of a 437-node tree took 68 ms this way and 80.6 s with
 * one `pgrep -P` per node, and the Codex hook's process proof runs such a walk under its tab lock.
 */
export const readProcChildren = async (pid: number): Promise<number[] | null> => {
  let tasks: string[];
  try {
    tasks = await fs.readdir(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  const found = new Set<number>();
  let readable = false;
  await Promise.all(tasks.map(async (tid) => {
    try {
      const raw = await fs.readFile(`/proc/${pid}/task/${tid}/children`, 'utf-8');
      readable = true;
      for (const part of raw.trim().split(/\s+/)) {
        const child = parseInt(part, 10);
        if (!Number.isNaN(child)) found.add(child);
      }
    } catch {
      // the thread exited, or the kernel has no children lists
    }
  }));
  if (!readable) {
    try {
      await fs.access(`/proc/${pid}`);
    } catch {
      return [];
    }
    return null;
  }
  return [...found].sort((a, b) => a - b);
};

export const getChildPids = async (parentPid: number): Promise<number[]> => {
  if (isLinux) {
    const children = await readProcChildren(parentPid);
    if (children) return children;
  }
  try {
    const { stdout } = await execFile('pgrep', ['-P', String(parentPid)]);
    return stdout.trim().split('\n').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
  } catch {
    return [];
  }
};

export const getProcessCwd = async (pid: number): Promise<string | null> => {
  if (isLinux) {
    try {
      return await fs.readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const line = stdout.split('\n').find((l) => l.startsWith('n/'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
};

export const parseSemanticVersion = (stdout: string): string | null =>
  stdout.trim().match(/(\d+\.\d+[\d.]*)/)?.[1] ?? null;

export const getProcessArgs = async (
  pid: number | string,
  options?: { timeoutMs?: number },
): Promise<string | null> => {
  try {
    const { stdout } = await execFile(
      'ps', ['-p', String(pid), '-o', 'args='],
      options?.timeoutMs ? { timeout: options.timeoutMs } : {},
    );
    return stdout.trim();
  } catch {
    return null;
  }
};

/** Exact argv tokens where the host exposes them; process proof must not parse ps text. */
export const getProcessArgv = async (pid: number): Promise<string[] | null> => {
  if (!isLinux) return null;
  try {
    const raw = await fs.readFile(`/proc/${pid}/cmdline`);
    if (raw.length === 0) return null;
    const argv = raw.toString('utf8').split('\0').filter((part) => part.length > 0);
    return argv.length > 0 ? argv : null;
  } catch {
    return null;
  }
};

export const getProcessStartTimeMs = async (
  pid: number | string,
  options?: { timeoutMs?: number },
): Promise<number | null> => {
  try {
    const { stdout } = await execFile(
      'ps', ['-p', String(pid), '-o', 'lstart='],
      options?.timeoutMs ? { timeout: options.timeoutMs } : {},
    );
    const parsed = Date.parse(stdout.trim().replace(/\s+/g, ' '));
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export type TStrictRuntimeObservation =
  | { state: 'present'; identity: string }
  | { state: 'absent'; reason: string }
  | { state: 'unknown'; reason: string };

/** Bounded process inventory: errors and unreadable argv are uncertainty, never death. */
export const observeProviderProcess = async (rootPid: number, provider: 'claude' | 'codex' | 'grok'): Promise<TStrictRuntimeObservation> => {
  if (!isLinux) return { state: 'unknown', reason: 'strict process identity unavailable on this platform' };
  try {
    const { stdout } = await execFile('ps', ['-eo', 'pid=,ppid=,comm='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const rows = stdout.trim().split('\n').map((line) => /^(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim()));
    if (rows.some((row) => !row)) return { state: 'unknown', reason: 'invalid process inventory' };
    const processes = rows.map((row) => ({ pid: Number(row![1]), parent: Number(row![2]), command: row![3] }));
    if (!processes.some((process) => process.pid === rootPid)) return { state: 'unknown', reason: 'pane process changed during observation' };
    const descendants = new Set([rootPid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const process of processes) if (descendants.has(process.parent) && !descendants.has(process.pid)) { descendants.add(process.pid); changed = true; }
      if (descendants.size > 512) return { state: 'unknown', reason: 'process inventory bound exceeded' };
    }
    for (const process of processes.filter((entry) => descendants.has(entry.pid))) {
      const argv = await getProcessArgv(process.pid);
      if (!argv) return { state: 'unknown', reason: 'process identity unreadable or changed' };
      const executable = argv[0].split('/').pop();
      const entrypoint = argv[1] ?? '';
      const matches = executable === provider || process.command === provider
        || (['node', 'bun'].includes(executable ?? '') && (entrypoint.endsWith(`/${provider}.js`)
          || provider === 'claude' && entrypoint.includes('/@anthropic-ai/claude-code/')
          || provider === 'codex' && entrypoint.includes('/@openai/codex/')
          || provider === 'grok' && entrypoint.includes('/grok-cli/')));
      if (matches) {
        const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
        const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        if (!started) return { state: 'unknown', reason: 'process start identity unavailable' };
        return { state: 'present', identity: `${process.pid}:${started}:${provider}` };
      }
    }
    return { state: 'absent', reason: `strict process inventory contains no ${provider} provider` };
  } catch {
    return { state: 'unknown', reason: 'process inventory failed or timed out' };
  }
};

/** A fresh background-job observation; permissions and unsupported hosts stay unknown. */
export const observeProcessExistence = async (pid: number): Promise<TStrictRuntimeObservation> => {
  if (!isLinux || !Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown', reason: 'process identity unavailable' };
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (!fields[19]) return { state: 'unknown', reason: 'process identity malformed' };
    if (fields[0] === 'Z' || fields[0] === 'X') return { state: 'absent', reason: 'process exited' };
    return { state: 'present', identity: `${pid}:${fields[19]}` };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'absent', reason: 'process absent' } : { state: 'unknown', reason: 'process identity unreadable' };
  }
};
