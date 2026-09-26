import fs from 'fs';
import os from 'os';
import path from 'path';

// Every test process runs with HOME pointed at a temporary root, so nothing a
// test does — the pino file logger above all, which resolves ~/.purplemux/logs
// at load — can reach the real ~/.purplemux the LIVE server writes. Workers are
// forked after this runs and inherit the environment; each then moves to its own
// directory under the root (tests/setup/record-pid.ts).
//
// The guard: each worker records its pid. At the end of the run, any line that
// one of those pids APPENDED to the real ~/.purplemux/logs during the run fails
// it. Measured 2026-09-26: test runs had been writing `status` lines (and error
// lines with fake-clock stamps) into the live log.
//
// Scope: the guard reads only the real `logs/*.log` files and only the worker
// pids. It is meant for `vitest run` (the gate): in a watch session left open for
// hours the pid counter can wrap between the start snapshot and the exit scan.
// Store files under ~/.purplemux and processes that tests spawn are kept
// out by HOME itself (every spawning test passes or inherits a temporary HOME),
// not by this check.

export const REAL_HOME_ENV = 'PMUX_TEST_REAL_HOME';
export const HOME_ROOT_ENV = 'PMUX_TEST_HOME_ROOT';

const OFFSETS_FILE = '.log-offsets.json';
const PIDS_DIR = '.pids';

export interface ILeak {
  file: string;
  pid: number;
  line: string;
}

export interface ILeakScan {
  leaks: ILeak[];
  /** Files the guard could not read: a guard that cannot look must not pass. */
  unreadable: string[];
}

const logDirOf = (realHome: string): string => path.join(realHome, '.purplemux', 'logs');

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/** The size of every real log file now: the scan later reads only what was appended after it. */
export const snapshotLogSizes = (realHome: string): Record<string, number> => {
  const dir = logDirOf(realHome);
  const sizes: Record<string, number> = {};
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (isMissing(err)) return sizes;
    throw err;
  }
  for (const name of names.filter((n) => n.endsWith('.log'))) {
    try {
      sizes[name] = fs.statSync(path.join(dir, name)).size;
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return sizes;
};

const readAppended = (file: string, from: number): string => {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    // A file rotated and recreated smaller than before is read from its start.
    const start = size < from ? 0 : from;
    const length = size - start;
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Lines appended to the real log files since `before` (a size snapshot) by any
 * of `pids`. Only a missing file or directory is skipped; any other read error
 * is reported, because a guard that cannot read must not pass.
 */
export const findLeakedLogLines = (realHome: string, pids: ReadonlySet<number>, before: Record<string, number>): ILeakScan => {
  const dir = logDirOf(realHome);
  const scan: ILeakScan = { leaks: [], unreadable: [] };
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.log'));
  } catch (err) {
    if (!isMissing(err)) scan.unreadable.push(`${dir}: ${(err as Error).message}`);
    return scan;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let appended: string;
    try {
      appended = readAppended(file, before[name] ?? 0);
    } catch (err) {
      if (!isMissing(err)) scan.unreadable.push(`${file}: ${(err as Error).message}`);
      continue;
    }
    for (const line of appended.split('\n')) {
      if (!line) continue;
      let entry: { pid?: unknown };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry.pid === 'number' && pids.has(entry.pid)) scan.leaks.push({ file, pid: entry.pid, line: line.slice(0, 200) });
    }
  }
  return scan;
};

/** The recorded worker pids, or null when none could be read (the guard cannot look). */
const readPids = (root: string): Set<number> | null => {
  try {
    const pids = new Set(fs.readdirSync(path.join(root, PIDS_DIR)).map(Number).filter(Number.isInteger));
    return pids.size > 0 ? pids : null;
  } catch {
    return null;
  }
};

/**
 * The end-of-run verdict. Sets `process.exitCode = 1` and throws on a leak or an
 * unreadable log: vitest prints a thrown teardown error but still exits 0, and
 * the exit code is what a gate reads.
 */
export const verifyNoLeaks = (realHome: string, root: string): void => {
  let before: Record<string, number> = {};
  try {
    before = JSON.parse(fs.readFileSync(path.join(root, OFFSETS_FILE), 'utf-8'));
  } catch {
    // no snapshot: every line of every file is in scope, which can only over-report
  }
  const pids = readPids(root);
  const { leaks, unreadable } = pids
    ? findLeakedLogLines(realHome, pids, before)
    : { leaks: [], unreadable: [`${path.join(root, PIDS_DIR)}: no worker pid was recorded`] };
  if (leaks.length === 0 && unreadable.length === 0) return;
  process.exitCode = 1;
  const parts: string[] = [];
  if (leaks.length > 0) {
    parts.push(`test processes wrote ${leaks.length} line(s) into the real ${logDirOf(realHome)}; isolate them (HOME, os mock or logger mock). First: `
      + leaks.slice(0, 3).map((l) => `pid ${l.pid} ${path.basename(l.file)}: ${l.line}`).join(' | '));
  }
  if (unreadable.length > 0) parts.push(`the leak guard could not read: ${unreadable.join('; ')}`);
  throw new Error(parts.join(' — '));
};

export default function setup(): () => void {
  const realHome = os.homedir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-test-home-'));
  fs.writeFileSync(path.join(root, OFFSETS_FILE), JSON.stringify(snapshotLogSizes(realHome)));
  process.env[REAL_HOME_ENV] = realHome;
  process.env[HOME_ROOT_ENV] = root;
  process.env.HOME = root;

  return () => {
    try {
      verifyNoLeaks(realHome, root);
    } finally {
      process.env.HOME = realHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
