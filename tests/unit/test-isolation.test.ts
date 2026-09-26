import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findLeakedLogLines, HOME_ROOT_ENV, REAL_HOME_ENV, snapshotLogSizes, verifyNoLeaks } from '../setup/isolated-home';

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const line = (pid: number, msg: string) => JSON.stringify({ level: 50, pid, module: 'status', msg });

/** A fake "real home" with one live log file. */
const fakeRealHome = (lines: string[]) => {
  const home = tmp('pmux-fake-real-');
  const logs = path.join(home, '.purplemux', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'purplemux.2026-09-26.1.log'), lines.map((l) => `${l}\n`).join(''));
  return { home, logs, file: path.join(logs, 'purplemux.2026-09-26.1.log') };
};

describe('test process isolation from the live ~/.purplemux', () => {
  it('runs every test with a HOME under the isolated root, never the real home', () => {
    const realHome = process.env[REAL_HOME_ENV]!;
    const root = process.env[HOME_ROOT_ENV]!;
    expect(realHome).toBeTruthy();
    expect(os.homedir()).toBe(path.join(root, `w-${process.pid}`));
    expect(os.homedir().startsWith(realHome + path.sep)).toBe(false);
  });

  it('recorded this worker\'s pid for the end-of-run leak guard', () => {
    expect(fs.existsSync(path.join(process.env[HOME_ROOT_ENV]!, '.pids', String(process.pid)))).toBe(true);
  });
});

describe('leak scan', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  it('reads only what was appended after the snapshot: an old line with a reused pid is not a leak', () => {
    const { home, file } = fakeRealHome([line(111, 'written hours ago by a pid now reused')]);
    homes.push(home);
    const before = snapshotLogSizes(home);
    expect(findLeakedLogLines(home, new Set([111]), before)).toEqual({ leaks: [], unreadable: [] });
    fs.appendFileSync(file, `${line(222, 'live server')}\n${line(111, 'this run')}\nnot json\n`);
    const scan = findLeakedLogLines(home, new Set([111]), before);
    expect(scan.unreadable).toEqual([]);
    expect(scan.leaks.map((l) => [l.pid, JSON.parse(l.line).msg])).toEqual([[111, 'this run']]);
  });

  it('reads a file created during the run in full, and one rotated smaller from its start', () => {
    const { home, logs, file } = fakeRealHome([line(1, 'x'.repeat(200))]);
    homes.push(home);
    const before = snapshotLogSizes(home);
    fs.writeFileSync(path.join(logs, 'purplemux.2026-09-27.1.log'), `${line(111, 'new file')}\n`);
    fs.writeFileSync(file, `${line(111, 'rotated')}\n`);
    expect(findLeakedLogLines(home, new Set([111]), before).leaks.map((l) => JSON.parse(l.line).msg).sort()).toEqual(['new file', 'rotated']);
  });

  it('treats a missing log dir as nothing to scan, and any other read error as unreadable', () => {
    const home = tmp('pmux-fake-real-');
    homes.push(home);
    expect(findLeakedLogLines(home, new Set([1]), {})).toEqual({ leaks: [], unreadable: [] });
    const logs = path.join(home, '.purplemux', 'logs');
    fs.mkdirSync(path.join(logs, 'purplemux.dir.log'), { recursive: true }); // EISDIR on read
    expect(findLeakedLogLines(home, new Set([1]), {}).unreadable).toEqual([expect.stringContaining('purplemux.dir.log')]);
  });
});

describe('verifyNoLeaks', () => {
  const saved = process.exitCode;
  const homes: string[] = [];
  afterEach(() => {
    process.exitCode = saved;
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  const rootWith = (pids: number[], offsets: Record<string, number>) => {
    const root = tmp('pmux-fake-root-');
    homes.push(root);
    fs.mkdirSync(path.join(root, '.pids'));
    for (const pid of pids) fs.writeFileSync(path.join(root, '.pids', String(pid)), '');
    fs.writeFileSync(path.join(root, '.log-offsets.json'), JSON.stringify(offsets));
    return root;
  };

  it('sets exit code 1 and throws on a leak (a thrown teardown alone exits 0)', () => {
    const { home, file } = fakeRealHome([]);
    homes.push(home);
    const root = rootWith([111], snapshotLogSizes(home));
    fs.appendFileSync(file, `${line(111, 'leak')}\n`);
    expect(() => verifyNoLeaks(home, root)).toThrow(/wrote 1 line\(s\) into the real/);
    expect(process.exitCode).toBe(1);
  });

  it('sets exit code 1 when the logs cannot be read', () => {
    const home = tmp('pmux-fake-real-');
    homes.push(home);
    fs.mkdirSync(path.join(home, '.purplemux', 'logs', 'purplemux.dir.log'), { recursive: true });
    const root = rootWith([111], {});
    expect(() => verifyNoLeaks(home, root)).toThrow(/could not read/);
    expect(process.exitCode).toBe(1);
  });

  it('passes quietly on a clean run', () => {
    const { home, file } = fakeRealHome([line(111, 'before the run')]);
    homes.push(home);
    const root = rootWith([111], snapshotLogSizes(home));
    fs.appendFileSync(file, `${line(999, 'live server')}\n`);
    process.exitCode = 0;
    expect(() => verifyNoLeaks(home, root)).not.toThrow();
    expect(process.exitCode).toBe(0);
  });
});

describe('the worker logger', () => {
  it('stays in the worker HOME even when a test mocks os.homedir() to a temp dir', async () => {
    const mocked = tmp('pmux-mocked-home-');
    try {
      vi.resetModules();
      vi.doMock('os', async (importOriginal) => {
        const actual = await importOriginal<typeof import('os')>();
        return { ...actual, default: { ...actual, homedir: () => mocked }, homedir: () => mocked };
      });
      const { createLogger } = await import('@/lib/logger');
      const marker = `isolation-marker-${process.pid}-${Date.now()}`;
      createLogger('isolation-probe').warn(marker);
      const workerLogs = path.join(process.env[HOME_ROOT_ENV]!, `w-${process.pid}`, '.purplemux', 'logs');
      await vi.waitFor(() => {
        const text = fs.readdirSync(workerLogs).map((n) => fs.readFileSync(path.join(workerLogs, n), 'utf-8')).join('');
        expect(text).toContain(marker);
      }, { timeout: 5000 });
      expect(fs.existsSync(path.join(mocked, '.purplemux', 'logs'))).toBe(false);
    } finally {
      vi.doUnmock('os');
      vi.resetModules();
      fs.rmSync(mocked, { recursive: true, force: true });
    }
  });
});
