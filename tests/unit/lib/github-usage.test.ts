import { describe, expect, it } from 'vitest';
import { GhCallLedger, HOUR_MS, type IGhCallCount } from '@/lib/github-usage-ledger';
import {
  GITHUB_USAGE_RESIDUAL,
  aggregateOwners,
  buildGithubUsageView,
  redactGithubUsage,
  topOwnersLastHour,
  type IUsageDeps,
} from '@/lib/github-usage';

// `purplemux github usage` — the quota per account and the top owners of the calls.

const NOW = Date.UTC(2026, 10, 18, 8, 0, 0);
const MIN = 60_000;

const count = (over: Partial<IGhCallCount>): IGhCallCount => ({
  source: 'tab', workspaceId: 'ws-1', tabId: 'tab-a', kind: 'rest', w1: 'run', w2: 'view', at: NOW - MIN, count: 1, ...over,
});

const NAMES = new Map([
  ['ws-1', { name: 'epic-a', tabs: new Map([['tab-a', 'worker-1'], ['tab-b', 'runner']]) }],
]);

describe('aggregateOwners', () => {
  it('splits REST and GraphQL per owner and source, with the top 3 subcommands', () => {
    const counts = [
      count({ count: 5 }),
      count({ w1: 'api', w2: 'rest', count: 3 }),
      count({ w1: 'pr', w2: 'checks', kind: 'graphql', count: 2 }),
      count({ w1: 'pr', w2: 'diff', count: 1 }),
      count({ source: 'server', w1: 'api', w2: 'graphql', kind: 'graphql', count: 7 }),
      count({ tabId: '-', workspaceId: '-', count: 4 }),
      count({ tabId: 'tab-z', at: NOW - 2 * HOUR_MS, count: 50 }),
    ];
    const w = aggregateOwners(counts, NOW - HOUR_MS, NAMES, 10);
    expect(w).toMatchObject({ total: 22, rest: 13, graphql: 9, ownersOmitted: 0 });
    expect(w.owners[0]).toEqual({
      source: 'tab', workspaceId: 'ws-1', workspaceName: 'epic-a', tabId: 'tab-a', tabName: 'worker-1', rest: 9, graphql: 2, total: 11,
      top: [{ command: 'run view', count: 5 }, { command: 'api rest', count: 3 }, { command: 'pr checks', count: 2 }],
    });
    expect(w.owners[1]).toMatchObject({ source: 'server', tabId: 'tab-a', graphql: 7, total: 7, top: [{ command: 'api graphql', count: 7 }] });
    expect(w.owners[2]).toMatchObject({ source: 'tab', tabId: '-', workspaceId: '-', tabName: null, workspaceName: null, total: 4 });
  });

  it('keeps the limit and counts what it left out', () => {
    const counts = Array.from({ length: 5 }, (_, i) => count({ tabId: `tab-${i}`, count: i + 1 }));
    const w = aggregateOwners(counts, NOW - HOUR_MS, NAMES, 2);
    expect(w.owners.map((o) => o.tabId)).toEqual(['tab-4', 'tab-3']);
    expect(w.ownersOmitted).toBe(3);
    expect(w.total).toBe(15);
  });
});

const deps = (over: Partial<IUsageDeps> = {}): IUsageDeps => {
  const ledger = new GhCallLedger(NOW - 3 * HOUR_MS);
  ledger.record({ workspaceId: 'ws-1', tabId: 'tab-b' }, ['api', 'graphql', '-f', 'query=q'], NOW - 5 * MIN);
  return {
    now: () => NOW,
    ledger: () => ledger,
    tabCalls: async () => ({ counts: [count({ count: 3 })], skippedLines: 0, pruned: [], error: null }),
    quota: () => ({
      at: NOW - MIN, error: null,
      accounts: [
        { login: 'agent-bot', role: 'agent', state: 'read', readAt: NOW - MIN, core: { remaining: 4000, limit: 5000, reset: 1 }, graphql: { remaining: 4900, limit: 5000, reset: 2 } },
        { login: 'mattdone01', role: 'owner', state: 'not-read', reason: 'not read (owner account)' },
      ],
    }),
    names: async () => NAMES,
    shim: () => ({ installed: true, reason: null }),
    tabCallsDir: () => '/h/.local/state/purplemux/gh-calls',
    ...over,
  };
};

describe('buildGithubUsageView', () => {
  it('holds the accounts, both windows, the ledger start and the residual footer', async () => {
    const view = await buildGithubUsageView(deps());
    expect(view.at).toBe(new Date(NOW).toISOString());
    expect(view.accounts.map((a) => [a.login, a.state])).toEqual([['agent-bot', 'read'], ['mattdone01', 'not-read']]);
    expect(view.windows.map((w) => [w.window, w.total])).toEqual([['1h', 4], ['24h', 4]]);
    expect(view.windows[0].owners.map((o) => [o.source, o.tabName])).toEqual([['tab', 'worker-1'], ['server', 'runner']]);
    expect(view.serverLedgerStartedAt).toBe(new Date(NOW - 3 * HOUR_MS).toISOString());
    expect(view.footer).toEqual([
      `server ledger since ${new Date(NOW - 3 * HOUR_MS).toISOString()} (in memory: a restart starts it again)`,
      GITHUB_USAGE_RESIDUAL,
    ]);
    expect(GITHUB_USAGE_RESIDUAL).toMatch(/resets PATH/);
    expect(GITHUB_USAGE_RESIDUAL).toMatch(/rc puts another gh before the shim/);
    expect(GITHUB_USAGE_RESIDUAL).toMatch(/\/usr\/bin\/gh/);
    expect(GITHUB_USAGE_RESIDUAL).toMatch(/remote tabs are not counted/);
  });

  it('says when no quota was read yet, the tab log is unreadable, or no shim is installed', async () => {
    const view = await buildGithubUsageView(deps({
      quota: () => null,
      tabCalls: async () => ({ counts: [], skippedLines: 2, pruned: [], error: 'EACCES' }),
      shim: () => ({ installed: false, reason: 'no gh on PATH' }),
    }));
    expect(view.accounts).toEqual([]);
    expect(view.quotaReadAt).toBeNull();
    expect(view.tabLog).toEqual({ dir: '/h/.local/state/purplemux/gh-calls', shimInstalled: false, shimReason: 'no gh on PATH', error: 'EACCES', skippedLines: 2 });
    expect(view.footer).toEqual(expect.arrayContaining([
      'quota: not read yet (the first read runs within 5 minutes of the start)',
      'tab calls: the log could not be read (EACCES), so the tab counts are missing, not zero',
      'tab calls: no gh shim is installed (no gh on PATH), so no tab call is counted',
      'tab calls: 2 log lines did not parse and are not counted',
    ]));
  });
});

describe('topOwnersLastHour', () => {
  it('ranks the owners of both sources by REST calls in the last hour', async () => {
    const d = deps({
      tabCalls: async () => ({
        counts: [count({ count: 3 }), count({ tabId: 'tab-b', source: 'tab', count: 9 }), count({ tabId: 'tab-b', at: NOW - 2 * HOUR_MS, count: 99 })],
        skippedLines: 0, pruned: [], error: null,
      }),
    });
    d.ledger().record({ workspaceId: 'ws-1', tabId: 'tab-a' }, ['api', 'repos/x'], NOW - MIN);
    expect(await topOwnersLastHour(d)).toEqual([
      { label: 'runner (epic-a)', rest: 9 },
      { label: 'worker-1 (epic-a)', rest: 4 },
    ]);
  });
});

describe('redactGithubUsage', () => {
  it('hides the tabs and workspaces the caller cannot read, keeping the counts', async () => {
    const view = await buildGithubUsageView(deps());
    const redacted = await redactGithubUsage(view, async (ws) => ws !== 'ws-1');
    expect(redacted.windows[0].owners.map((o) => [o.workspaceId, o.tabId, o.tabName, o.total])).toEqual([['other', 'other', null, 3], ['other', 'other', null, 1]]);
    expect(redacted.accounts).toEqual(view.accounts);
  });
});
