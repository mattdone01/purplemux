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
