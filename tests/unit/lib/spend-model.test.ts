import { describe, expect, it } from 'vitest';
import { buildSpendView, isUtcDay, rangeDays, addUtcDays, tokensByDay } from '@/lib/spend/spend-model';
import type { ISpendModelInput } from '@/lib/spend/spend-model';
import type { ISpendRow, ISpendUsage, TSpendBy } from '@/types/spend';

const OPUS = 'claude-opus-4-6';

const usage = (overrides: Partial<ISpendUsage>): ISpendUsage => ({
  providerId: 'claude', workspaceId: 'ws-a', sessionId: 's-1', day: '2026-10-20', model: OPUS, sidechain: false,
  input: 100, output: 10, cacheRead: 1000, cacheCreation: 50, cacheCreation5m: 50, cacheCreation1h: 0, ...overrides,
});

const INDEX = { state: 'ready' as const, filesIndexed: 3, filesTotal: 3, indexedThrough: 1 };

const input = (overrides: Partial<ISpendModelInput> = {}): ISpendModelInput => ({
  usage: [
    usage({}),
    usage({ sessionId: 's-1', sidechain: true, input: 7, output: 3, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0 }),
    usage({ sessionId: 's-2', day: '2026-10-21', model: 'claude-sonnet-4-5' }),
    usage({ sessionId: 's-unbound', day: '2026-10-21' }),
    usage({ providerId: 'codex', workspaceId: null, sessionId: 'c-1', model: 'gpt-5-codex', cacheCreation: 0, cacheCreation5m: 0, costUsd: 0.5 }),
    usage({ providerId: 'codex', workspaceId: null, sessionId: 'c-unbound', model: 'gpt-5-codex', costUsd: null }),
    usage({ workspaceId: 'global', sessionId: 'g-1' }),
    usage({ workspaceId: 'ws-b', sessionId: 'b-1' }),
  ],
  bindings: {
    'claude:s-1': { workspaceId: 'ws-a', tabId: 'tab-orch' },
    'claude:s-2': { workspaceId: 'ws-a', tabId: 'tab-worker' },
    'codex:c-1': { workspaceId: 'ws-a', tabId: 'tab-codex' },
    'claude:b-1': { workspaceId: 'ws-b', tabId: 'tab-b' },
  },
  workspaces: [
    { id: 'ws-a', name: 'Alpha', orchestratorTabId: 'tab-orch', tabs: { 'tab-orch': 'orchestrator', 'tab-worker': 'worker one' } },
    { id: 'ws-b', name: 'Beta', orchestratorTabId: null, tabs: { 'tab-b': 'beta tab' } },
  ],
  workspaceId: 'ws-a', from: '2026-10-20', to: '2026-10-26', by: 'tab', generatedAt: 42, index: INDEX,
  ...overrides,
});

const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens', 'sidechainTokens', 'unpricedTokens'] as const;

const expectSumInvariant = (view: ReturnType<typeof buildSpendView>) => {
  for (const field of FIELDS) {
    const sum = view.rows.reduce((total, row) => total + row[field], 0) + (view.unattributed?.[field] ?? 0);
    expect(sum, field).toBe(view.totals[field]);
  }
  const costs = [...view.rows, ...(view.unattributed ? [view.unattributed] : [])].map((row) => row.costUsd ?? 0);
  expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(view.totals.costUsd ?? 0, 9);
};

const row = (rows: ISpendRow[], key: string) => rows.find((candidate) => candidate.key === key);

describe('spend model', () => {
  it.each<[string | 'all', TSpendBy]>([
    ['ws-a', 'tab'], ['ws-a', 'day'], ['ws-a', 'model'], ['ws-a', 'role'],
    ['all', 'tab'], ['all', 'day'], ['all', 'model'], ['all', 'role'], ['all', 'workspace'],
  ])('keeps sum(rows) + unattributed = totals for %s by %s', (workspaceId, by) => {
    expectSumInvariant(buildSpendView(input({ workspaceId, by })));
  });

  it('attributes a bound session to its tab, subagents under the parent session', () => {
    const view = buildSpendView(input());
    const orchestrator = row(view.rows, 'tab-orch')!;
    expect(orchestrator.label).toBe('orchestrator');
    expect(orchestrator.inputTokens).toBe(107);
    expect(orchestrator.sidechainTokens).toBe(10);
    expect(orchestrator.totalTokens).toBe(1160 + 10);
    expect(row(view.rows, 'tab-codex')).toMatchObject({ label: 'tab-codex (closed)', providerId: 'codex', costUsd: 0.5 });
  });

  it('counts a session no binding names as unattributed in its workspace, never dropped and never 0', () => {
    const view = buildSpendView(input());
    expect(view.unattributed).toMatchObject({ key: 'unattributed', label: 'Not bound to a tab', totalTokens: 1160 });
    expect(view.rows.some((candidate) => candidate.key === 'unattributed')).toBe(false);
  });

  it('keeps unbound Codex usage out of a workspace and in the fleet total as unattributed', () => {
    const scoped = buildSpendView(input({ by: 'workspace', workspaceId: 'all' }));
    expect(scoped.unattributed).toMatchObject({ label: 'Workspace not known', providerId: 'codex', totalTokens: 1160 });
    expect(row(scoped.rows, 'global')).toMatchObject({ label: 'Outside every workspace' });
    expect(row(scoped.rows, 'ws-a')?.label).toBe('Alpha');
    const workspace = buildSpendView(input());
    expect(workspace.totals.totalTokens).toBe(1160 + 10 + 1160 + 1160 + 1110);
  });

  it('never attributes a tab whose binding names another workspace', () => {
    const view = buildSpendView(input({ bindings: { 'claude:g-1': { workspaceId: 'ws-a', tabId: 'tab-orch' } }, workspaceId: 'all' }));
    expect(row(view.rows, 'tab-orch')).toBeUndefined();
  });

  it('splits role into the current orchestrator and other tabs, and says the basis', () => {
    const view = buildSpendView(input({ by: 'role' }));
    expect(view.roleBasis).toBe('current-orchestrator');
    expect(row(view.rows, 'orchestrator')).toMatchObject({ label: 'Orchestrator', totalTokens: 1170 });
    expect(row(view.rows, 'other')).toMatchObject({ label: 'Other tabs' });
    expect(view.unattributed?.totalTokens).toBe(1160);
    expect(buildSpendView(input({ by: 'tab' })).roleBasis).toBeUndefined();
  });

  it('orders days ascending and other keys by tokens', () => {
    const days = buildSpendView(input({ by: 'day' }));
    expect(days.rows.map((candidate) => candidate.key)).toEqual(['2026-10-20', '2026-10-21']);
    expect(days.unattributed).toBeNull();
    expect(tokensByDay(days)).toEqual(days.rows.map((candidate) => ({ day: candidate.key, totalTokens: candidate.totalTokens, sidechainTokens: candidate.sidechainTokens })));
    const models = buildSpendView(input({ by: 'model' }));
    expect(models.rows[0].totalTokens).toBeGreaterThanOrEqual(models.rows[1].totalTokens);
    expect(row(models.rows, OPUS)?.label).toBe('Opus 4.6');
    expect(row(models.rows, 'gpt-5-codex')?.label).toBe('gpt-5-codex');
  });

  it('prices known models, puts unknown models in unpricedTokens, and leaves an unpriced row at null', () => {
    const view = buildSpendView(input({
      usage: [usage({ model: 'claude-mythos-1', sessionId: 's-1' }), usage({ sessionId: 's-2' })],
    }));
    expect(row(view.rows, 'tab-orch')).toMatchObject({ costUsd: null, unpricedTokens: 1160 });
    const priced = row(view.rows, 'tab-worker')!;
    expect(priced.unpricedTokens).toBe(0);
    expect(priced.costUsd).toBeCloseTo((100 * 5 + 50 * 6.25 + 1000 * 0.5 + 10 * 25) / 1_000_000, 12);
    expect(view.totals.costUsd).toBeCloseTo(priced.costUsd!, 12);
    expect(view.totals.unpricedTokens).toBe(1160);
  });

  it('answers an empty period with zero totals, no rows and a null cost', () => {
    const view = buildSpendView(input({ from: '2026-01-01', to: '2026-01-02' }));
    expect(view.rows).toEqual([]);
    expect(view.unattributed).toBeNull();
    expect(view.totals).toMatchObject({ totalTokens: 0, costUsd: null });
    expect(view.dayBasis).toEqual({ claude: 'message', codex: 'session-start', grok: 'session-start' });
    expect(view.index).toBe(INDEX);
    expect(view.generatedAt).toBe(42);
  });

  it('names a removed workspace by id and a provider mix as null', () => {
    const view = buildSpendView(input({ workspaceId: 'all', by: 'workspace', workspaces: [] }));
    expect(row(view.rows, 'ws-a')).toMatchObject({ label: 'ws-a (removed)', providerId: null });
  });

  it('reads UTC days strictly', () => {
    expect(isUtcDay('2026-10-26')).toBe(true);
    expect(isUtcDay('2026-02-30')).toBe(false);
    expect(isUtcDay('2026-10-26T00:00')).toBe(false);
    expect(rangeDays('2026-10-20', '2026-10-26')).toBe(7);
    expect(addUtcDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
