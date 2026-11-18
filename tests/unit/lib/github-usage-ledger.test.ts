import { describe, expect, it } from 'vitest';
import {
  GH_COMMAND_WORDS,
  GhCallLedger,
  HOUR_MS,
  DAY_MS,
  classifyGhArgs,
  kindOfWords,
  ownerOfWatch,
} from '@/lib/github-usage-ledger';

// Every `gh` call the server makes, counted per owner tab, REST or GraphQL.

const T0 = 1_800_000_000_000;

describe('classifyGhArgs', () => {
  it.each([
    [['api', 'graphql', '-f', 'query=x'], 'graphql', 'api', 'graphql'],
    [['api', '-X', 'POST', 'graphql', '-f', 'query=x'], 'graphql', 'api', 'graphql'],
    [['api', 'repos/o/r/commits/main'], 'rest', 'api', 'rest'],
    [['api', 'rate_limit'], 'rest', 'api', 'rest'],
    [['pr', 'checks', '12'], 'graphql', 'pr', 'checks'],
    [['pr', 'view', '12', '--json', 'state'], 'graphql', 'pr', 'view'],
    [['pr', 'list'], 'graphql', 'pr', 'list'],
    [['pr', 'diff', '12'], 'rest', 'pr', 'diff'],
    [['run', 'view', '1'], 'rest', 'run', 'view'],
    [['run', 'watch', '1'], 'rest', 'run', 'watch'],
    [['run', 'list'], 'rest', 'run', 'list'],
  ] as const)('%j is %s, recorded as "%s %s"', (args, kind, w1, w2) => {
    expect(classifyGhArgs([...args])).toEqual({ kind, w1, w2 });
  });

  it('never records an api path: only the kind', () => {
    const c = classifyGhArgs(['api', 'repos/o/r?token=ghp_SECRET']);
    expect(c).toEqual({ kind: 'rest', w1: 'api', w2: 'rest' });
    expect(JSON.stringify(c)).not.toContain('SECRET');
  });

  it('an unknown command or subcommand is ? and counts as REST', () => {
    expect(classifyGhArgs(['frobnicate', 'x'])).toEqual({ kind: 'rest', w1: '?', w2: '?' });
    expect(classifyGhArgs(['pr', 'ghp_SECRET'])).toEqual({ kind: 'rest', w1: 'pr', w2: '?' });
    expect(classifyGhArgs(['--version'])).toEqual({ kind: 'rest', w1: '?', w2: '?' });
    expect(classifyGhArgs([])).toEqual({ kind: 'rest', w1: '?', w2: '?' });
  });

  it('a command with no subcommand word records - for word 2', () => {
    expect(classifyGhArgs(['pr'])).toEqual({ kind: 'rest', w1: 'pr', w2: '-' });
    expect(classifyGhArgs(['status'])).toEqual({ kind: 'rest', w1: 'status', w2: '-' });
    expect(classifyGhArgs(['status', 'ghp_SECRET'])).toEqual({ kind: 'rest', w1: 'status', w2: '?' });
  });

  it('kindOfWords reads a shim line the same way', () => {
    expect(kindOfWords('api', 'graphql')).toBe('graphql');
    expect(kindOfWords('api', 'rest')).toBe('rest');
    expect(kindOfWords('pr', 'checks')).toBe('graphql');
    expect(kindOfWords('?', '?')).toBe('rest');
  });

  it('every allow-listed word is a plain lowercase word', () => {
    for (const [cmd, subs] of Object.entries(GH_COMMAND_WORDS)) {
      expect(cmd).toMatch(/^[a-z][a-z-]*$/);
      for (const sub of subs) expect(sub).toMatch(/^[a-z][a-z-]*$/);
    }
  });
});

describe('ownerOfWatch', () => {
  it('splits a watch owner into its workspace and tab', () => {
    expect(ownerOfWatch('ws-1/tab-a')).toEqual({ workspaceId: 'ws-1', tabId: 'tab-a' });
    expect(ownerOfWatch('nonsense')).toEqual({ workspaceId: '-', tabId: '-' });
  });
});

describe('GhCallLedger', () => {
  it('counts per owner and kind in the 1 h and 24 h windows', () => {
    const ledger = new GhCallLedger(T0);
    const a = { workspaceId: 'ws-1', tabId: 'tab-a' };
    ledger.record(a, ['api', 'graphql', '-f', 'query=q'], T0);
    ledger.record(a, ['api', 'repos/o/r/commits/x'], T0 + 23 * HOUR_MS);
    ledger.record(null, ['api', 'rate_limit'], T0 + 23 * HOUR_MS + 30 * 60_000);
    const now = T0 + 23 * HOUR_MS + 40 * 60_000;
    const hour = ledger.counts(now - HOUR_MS, now);
    expect(hour.reduce((n, c) => n + c.count, 0)).toBe(2);
    expect(hour.find((c) => c.tabId === 'tab-a')).toMatchObject({ source: 'server', workspaceId: 'ws-1', kind: 'rest', w1: 'api', w2: 'rest', count: 1 });
    expect(hour.find((c) => c.tabId === '-')).toMatchObject({ workspaceId: '-', count: 1 });
    const day = ledger.counts(now - DAY_MS, now);
    expect(day.reduce((n, c) => n + c.count, 0)).toBe(3);
    expect(day.filter((c) => c.kind === 'graphql').reduce((n, c) => n + c.count, 0)).toBe(1);
  });

  it('adds repeated calls in one minute into one count, and drops what is older than 24 h', () => {
    const ledger = new GhCallLedger(T0);
    const a = { workspaceId: 'ws-1', tabId: 'tab-a' };
    for (let i = 0; i < 5; i++) ledger.record(a, ['pr', 'checks', '1'], T0 + i * 1000);
    expect(ledger.counts(T0 - HOUR_MS, T0 + 10_000)).toEqual([
      expect.objectContaining({ count: 5, kind: 'graphql', w1: 'pr', w2: 'checks' }),
    ]);
    ledger.record(a, ['pr', 'checks', '1'], T0 + DAY_MS + 2 * 60_000);
    const later = T0 + DAY_MS + 3 * 60_000;
    expect(ledger.counts(0, later).reduce((n, c) => n + c.count, 0)).toBe(1);
  });

  it('keeps the time it started', () => {
    expect(new GhCallLedger(T0).startedAt).toBe(T0);
  });
});
