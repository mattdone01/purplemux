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

export const getChildPids = async (parentPid: number): Promise<number[]> => {
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
