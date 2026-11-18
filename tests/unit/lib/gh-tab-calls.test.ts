import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ghCallsDir, parseGhCallLine, readTabGhCalls } from '@/lib/gh-tab-calls';
import { HOUR_MS } from '@/lib/github-usage-ledger';

// The tab calls the gh shim logged, read back for the 1 h and 24 h windows.

const NOW = Date.UTC(2026, 10, 18, 8, 0, 0);
const S = (ms: number) => Math.floor(ms / 1000);

let dir = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-gh-calls-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ghCallsDir', () => {
  it('is under XDG_STATE_HOME, else ~/.local/state', () => {
    expect(ghCallsDir({ XDG_STATE_HOME: '/x/state' }, '/h')).toBe('/x/state/purplemux/gh-calls');
    expect(ghCallsDir({}, '/h')).toBe('/h/.local/state/purplemux/gh-calls');
    expect(ghCallsDir({ XDG_STATE_HOME: '' }, '/h')).toBe('/h/.local/state/purplemux/gh-calls');
  });
});

describe('parseGhCallLine', () => {
  it('reads a line the shim writes', () => {
    expect(parseGhCallLine(`${S(NOW)} tab-a ws-1 pr checks`)).toEqual({ at: NOW, tabId: 'tab-a', workspaceId: 'ws-1', w1: 'pr', w2: 'checks', kind: 'graphql' });
    expect(parseGhCallLine(`${S(NOW)} - - api rest`)).toMatchObject({ tabId: '-', workspaceId: '-', kind: 'rest' });
  });

  it('refuses a line that is not the shim grammar', () => {
    expect(parseGhCallLine('')).toBeNull();
    expect(parseGhCallLine(`${S(NOW)} tab-a ws-1 pr`)).toBeNull();
    expect(parseGhCallLine(`x tab-a ws-1 pr checks`)).toBeNull();
    expect(parseGhCallLine(`${S(NOW)} tab;a ws-1 pr checks`)).toBeNull();
    expect(parseGhCallLine(`${S(NOW)} tab-a ws-1 repos/o/r rest`)).toBeNull();
    expect(parseGhCallLine(`${S(NOW)} tab-a ws-1 api repos`)).toBeNull();
  });
});

describe('readTabGhCalls', () => {
  it('reads today and yesterday, adds calls per minute, and prunes older files', async () => {
    await fs.writeFile(path.join(dir, '20261118.log'), [
      `${S(NOW - 10 * 60_000)} tab-a ws-1 pr checks`,
      `${S(NOW - 10 * 60_000)} tab-a ws-1 pr checks`,
      `${S(NOW - 2 * HOUR_MS)} tab-b ws-1 api rest`,
      'garbage',
    ].join('\n') + '\n');
    await fs.writeFile(path.join(dir, '20261117.log'), `${S(NOW - 20 * HOUR_MS)} - - run view\n`);
    await fs.writeFile(path.join(dir, '20261116.log'), `${S(NOW - 40 * HOUR_MS)} tab-old ws-1 run view\n`);
    await fs.writeFile(path.join(dir, 'notes.txt'), 'kept');
    const read = await readTabGhCalls(dir, NOW);
    expect(read.error).toBeNull();
    expect(read.skippedLines).toBe(1);
    expect(read.pruned).toEqual(['20261116.log']);
    await expect(fs.stat(path.join(dir, '20261116.log'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, 'notes.txt'))).resolves.toBeTruthy();
    const total = (from: number) => read.counts.filter((c) => c.at >= from).reduce((n, c) => n + c.count, 0);
    expect(total(NOW - HOUR_MS)).toBe(2);
    expect(total(NOW - 24 * HOUR_MS)).toBe(4);
    expect(read.counts.find((c) => c.tabId === 'tab-a')).toMatchObject({ source: 'tab', count: 2, kind: 'graphql', w1: 'pr', w2: 'checks' });
    expect(read.counts.some((c) => c.tabId === 'tab-old')).toBe(false);
  });

  it('a missing directory is no calls, not an error', async () => {
    const read = await readTabGhCalls(path.join(dir, 'absent'), NOW);
    expect(read).toEqual({ counts: [], skippedLines: 0, pruned: [], error: null });
  });

  it('an unreadable directory is an error, never zero calls', async () => {
    const file = path.join(dir, 'file');
    await fs.writeFile(file, '');
    const read = await readTabGhCalls(file, NOW);
    expect(read.error).toMatch(/ENOTDIR/);
    expect(read.counts).toEqual([]);
  });
});
