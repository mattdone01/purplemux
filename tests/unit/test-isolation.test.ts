import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { findLeakedLogLines, HOME_ROOT_ENV, REAL_HOME_ENV } from '../setup/isolated-home';

describe('test process isolation from the live ~/.purplemux', () => {
  it('runs every test with HOME at the isolated root, never the real home', () => {
    const realHome = process.env[REAL_HOME_ENV];
    const root = process.env[HOME_ROOT_ENV];
    expect(realHome).toBeTruthy();
    expect(root).toBeTruthy();
    expect(os.homedir()).toBe(root);
    expect(os.homedir()).not.toBe(realHome);
  });

  it('recorded this worker\'s pid for the end-of-run leak guard', () => {
    expect(fs.existsSync(path.join(process.env[HOME_ROOT_ENV]!, '.pids', String(process.pid)))).toBe(true);
  });

  it('finds a leaked line by pid and time, and ignores other pids and older files', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-leak-scan-'));
    try {
      const logs = path.join(fakeHome, '.purplemux', 'logs');
      fs.mkdirSync(logs, { recursive: true });
      const since = Date.now() - 1_000;
      fs.writeFileSync(path.join(logs, 'purplemux.2026-09-26.1.log'), [
        JSON.stringify({ level: 50, pid: 111, module: 'status', msg: 'from a test worker' }),
        JSON.stringify({ level: 30, pid: 222, module: 'status', msg: 'from the live server' }),
        'not json',
      ].join('\n'));
      const old = path.join(logs, 'purplemux.2026-09-25.1.log');
      fs.writeFileSync(old, JSON.stringify({ pid: 111, msg: 'yesterday' }));
      fs.utimesSync(old, new Date(since - 60_000), new Date(since - 60_000));

      const leaks = findLeakedLogLines(fakeHome, new Set([111]), since);
      expect(leaks.map((l) => [l.pid, path.basename(l.file)])).toEqual([[111, 'purplemux.2026-09-26.1.log']]);
      expect(findLeakedLogLines(fakeHome, new Set([333]), since)).toEqual([]);
      expect(findLeakedLogLines(path.join(fakeHome, 'absent'), new Set([111]), since)).toEqual([]);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('the worker logger', () => {
  it('writes under the run-wide isolated HOME, whatever a test later mocks', async () => {
    const root = process.env[HOME_ROOT_ENV]!;
    const { createLogger } = await import('@/lib/logger');
    createLogger('isolation-probe').warn('isolation probe');
    await vi.waitFor(() => {
      const logs = path.join(root, '.purplemux', 'logs');
      expect(fs.existsSync(logs) && fs.readdirSync(logs).some((n) => n.startsWith('purplemux'))).toBe(true);
    }, { timeout: 5000 });
  });
});
