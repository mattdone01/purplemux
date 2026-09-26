import fs from 'fs';
import os from 'os';
import path from 'path';

// Every test process runs with HOME pointed at one temporary root, so nothing a
// test does — the pino file logger above all, which resolves ~/.purplemux/logs
// at load — can reach the real ~/.purplemux the LIVE server writes. Workers are
// forked after this runs and inherit the environment.
//
// The guard: each worker records its pid (tests/setup/record-pid.ts). At the end
// of the run, any line in the real ~/.purplemux/logs written by one of those pids
// fails the run. Measured 2026-09-26: test runs had been writing `status` lines
// (and error lines with fake-clock stamps) into the live log.

export const REAL_HOME_ENV = 'PMUX_TEST_REAL_HOME';
export const HOME_ROOT_ENV = 'PMUX_TEST_HOME_ROOT';

interface ILeak {
  file: string;
  pid: number;
  line: string;
}

/** Lines of the real log files, written by any of `pids` since `since` (ms). */
export const findLeakedLogLines = (realHome: string, pids: ReadonlySet<number>, since: number): ILeak[] => {
  const dir = path.join(realHome, '.purplemux', 'logs');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.log'));
  } catch {
    return [];
  }
  const leaks: ILeak[] = [];
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < since) continue;
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        if (!line) continue;
        let entry: { pid?: unknown };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof entry.pid === 'number' && pids.has(entry.pid)) leaks.push({ file, pid: entry.pid, line: line.slice(0, 200) });
      }
    } catch {
      // a log rotated away mid-scan is not a leak
    }
  }
  return leaks;
};

export default function setup(): () => void {
  const realHome = os.homedir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-test-home-'));
  const startedAt = Date.now();
  process.env[REAL_HOME_ENV] = realHome;
  process.env[HOME_ROOT_ENV] = root;
  process.env.HOME = root;

  return () => {
    const pidDir = path.join(root, '.pids');
    let pids = new Set<number>();
    try {
      pids = new Set(fs.readdirSync(pidDir).map(Number).filter(Number.isInteger));
    } catch {
      // no worker recorded a pid
    }
    const leaks = findLeakedLogLines(realHome, pids, startedAt);
    fs.rmSync(root, { recursive: true, force: true });
    if (leaks.length > 0) {
      // A thrown teardown error is printed but leaves vitest's exit code at 0;
      // the exit code is what a gate reads.
      process.exitCode = 1;
      throw new Error(
        `test processes wrote ${leaks.length} line(s) into the real ${path.join(realHome, '.purplemux', 'logs')}; `
        + `isolate them (HOME, os mock or logger mock). First: ${leaks.slice(0, 3).map((l) => `pid ${l.pid} ${path.basename(l.file)}: ${l.line}`).join(' | ')}`,
      );
    }
  };
}
