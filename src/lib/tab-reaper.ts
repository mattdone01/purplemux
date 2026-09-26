import fs from 'fs/promises';
import { readFileSync } from 'fs';
import os from 'os';

// A tab's processes die with the tab (ADR-0016, story 16). `killSession` signals
// only the pane shell's process group; jobs started with `&` have their own
// groups, and `disown`, `nohup` and `setsid` children survive the hang-up.
// Measured: a loop retried `tab send` to a closed tab for more than a day, and a
// poll outlived its merged PR by ~20 h.
//
// The tab-owned set is (a) every descendant of the pane pid and (b) every
// process of the server's uid whose environment holds exactly
// `PMUX_TAB_ID=<tabId>` (story 01 puts it in every tab's environment; it
// survives re-parenting). Never a pattern match (C-341).

export const REAP_GRACE_MS = 3_000;
const POLL_MS = 100;
const MAX_ARGS_CHARS = 200;

export interface IReapedProcess {
  pid: number;
  comm: string;
  args: string;
}

export interface IReapResult {
  /** `unavailable` without /proc (macOS): only the pane group is signalled (NFR-7). */
  reaper: 'linux' | 'unavailable';
  /** Whether the pane's own environment carries the tab marker (absent: a tab created before story 01). */
  envMarker: 'present' | 'absent' | 'unknown';
  killed: IReapedProcess[];
  survivors: IReapedProcess[];
}

export interface ITabReaperDeps {
  procAvailable: () => Promise<boolean>;
  listPids: () => Promise<number[]>;
  /** The raw NUL-separated environment, or null when it cannot be read. */
  readEnviron: (pid: number) => Promise<Buffer | null>;
  /** The owning uid, or null when the process is gone. */
  ownerUid: (pid: number) => Promise<number | null>;
  describe: (pid: number) => Promise<IReapedProcess>;
  descendants: (pid: number) => Promise<number[]>;
  /** The process group id, or null when the process is gone. */
  processGroup: (pid: number) => Promise<number | null>;
  /** Running or sleeping; a zombie (exited, not yet reaped by its parent) is not alive. */
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  selfPid: number;
  uid: number;
}

/** Exact entry match: `PMUX_TAB_ID=tab-ab` never matches `PMUX_TAB_ID=tab-abc`. */
export const environHasTabId = (environ: Buffer, tabId: string): boolean => {
  const wanted = `PMUX_TAB_ID=${tabId}`;
  return environ.toString('utf-8').split('\0').includes(wanted);
};

/** The fields of /proc/<pid>/stat after the parenthesised comm, which may itself contain spaces. */
const statFields = (raw: string): string[] => raw.slice(raw.lastIndexOf(')') + 2).split(' ');

const readText = async (file: string): Promise<string | null> => {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return null;
  }
};

export const defaultReaperDeps = (descendants: (pid: number) => Promise<number[]>): ITabReaperDeps => ({
  procAvailable: async () => {
    if (process.platform !== 'linux') return false;
    try {
      await fs.access('/proc/self/environ');
      return true;
    } catch {
      return false;
    }
  },
  listPids: async () => (await fs.readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number),
  readEnviron: async (pid) => {
    try {
      return await fs.readFile(`/proc/${pid}/environ`);
    } catch {
      return null;
    }
  },
  ownerUid: async (pid) => {
    try {
      return (await fs.stat(`/proc/${pid}`)).uid;
    } catch {
      return null;
    }
  },
  describe: async (pid) => {
    const comm = (await readText(`/proc/${pid}/comm`))?.trim() ?? '';
    const cmdline = (await readText(`/proc/${pid}/cmdline`)) ?? '';
    return { pid, comm, args: cmdline.split('\0').filter(Boolean).join(' ').slice(0, MAX_ARGS_CHARS) };
  },
  descendants,
  processGroup: async (pid) => {
    const raw = await readText(`/proc/${pid}/stat`);
    const pgid = raw ? Number(statFields(raw)[2]) : NaN;
    return Number.isInteger(pgid) ? pgid : null;
  },
  isAlive: (pid) => {
    try {
      const state = statFields(readFileSync(`/proc/${pid}/stat`, 'utf-8'))[0];
      return state !== 'Z' && state !== 'X';
    } catch {
      return false;
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  selfPid: process.pid,
  uid: os.userInfo().uid,
});

/** Every same-uid pid whose environment carries this tab's marker. */
const SCAN_BATCH = 64;

const markedPids = async (deps: ITabReaperDeps, tabId: string): Promise<number[]> => {
  const found: number[] = [];
  const pids = (await deps.listPids()).filter((pid) => pid !== deps.selfPid);
  // A busy host has thousands of processes; read them in parallel batches so the
  // scan does not eat into the 3 s grace the close is bounded by.
  for (let i = 0; i < pids.length; i += SCAN_BATCH) {
    const batch = pids.slice(i, i + SCAN_BATCH);
    const hits = await Promise.all(batch.map(async (pid) => {
      if ((await deps.ownerUid(pid)) !== deps.uid) return null;
      const environ = await deps.readEnviron(pid);
      return environ && environHasTabId(environ, tabId) ? pid : null;
    }));
    for (const pid of hits) if (pid !== null) found.push(pid);
  }
  return found;
};

const signal = (deps: ITabReaperDeps, pid: number, sig: NodeJS.Signals): void => {
  try {
    deps.kill(pid, sig);
  } catch {
    // already gone
  }
};

/**
 * Reap the tab's processes BEFORE its tmux session is killed, while the
 * environ scan still sees children whose parent is alive. SIGTERM, up to 3 s of
 * grace, SIGKILL survivors. `keepProcesses` skips the environ scan (today's
 * behaviour: the pane's process group only).
 */
export const reapTabProcesses = async (
  deps: ITabReaperDeps,
  opts: { tabId: string; panePid: number | null; keepProcesses?: boolean },
): Promise<IReapResult> => {
  const result: IReapResult = { reaper: 'unavailable', envMarker: 'unknown', killed: [], survivors: [] };
  if (!(await deps.procAvailable())) return result;
  result.reaper = 'linux';

  if (opts.panePid !== null) {
    const paneEnviron = await deps.readEnviron(opts.panePid);
    if (paneEnviron) result.envMarker = environHasTabId(paneEnviron, opts.tabId) ? 'present' : 'absent';
  }
  const targets = new Set<number>();
  if (opts.panePid !== null) {
    for (const pid of await deps.descendants(opts.panePid)) {
      // --keep-processes is today's behaviour: the pane's own process group only.
      if (opts.keepProcesses && (await deps.processGroup(pid)) !== opts.panePid) continue;
      targets.add(pid);
    }
  }
  if (!opts.keepProcesses) {
    for (const pid of await markedPids(deps, opts.tabId)) targets.add(pid);
  }
  targets.delete(deps.selfPid);
  if (opts.panePid !== null) targets.delete(opts.panePid); // the pane shell goes with the session

  const described = new Map<number, IReapedProcess>();
  for (const pid of targets) described.set(pid, await deps.describe(pid));
  for (const pid of targets) signal(deps, pid, 'SIGTERM');

  const deadline = deps.now() + REAP_GRACE_MS;
  let alive = [...targets].filter((pid) => deps.isAlive(pid));
  while (alive.length > 0 && deps.now() < deadline) {
    await deps.sleep(POLL_MS);
    alive = alive.filter((pid) => deps.isAlive(pid));
  }
  for (const pid of alive) signal(deps, pid, 'SIGKILL');
  if (alive.length > 0) await deps.sleep(POLL_MS);

  for (const pid of targets) {
    const entry = described.get(pid)!;
    if (deps.isAlive(pid)) result.survivors.push(entry);
    else result.killed.push(entry);
  }
  return result;
};
