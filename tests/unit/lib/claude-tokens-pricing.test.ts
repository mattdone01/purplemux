import { describe, expect, it } from 'vitest';
import { calculateCost, calculateCostByFullId, formatModelDisplayName, normalizeModelName } from '@/lib/claude-tokens';
import { buildOverview } from '@/lib/stats/stats-cache-parser';
import { buildSpendView } from '@/lib/spend/spend-model';
import type { IStatsCache } from '@/types/stats';

const M = 1_000_000;

describe('Claude 5 prices', () => {
  it.each([
    ['claude-opus-5-5', 4, 20, 5, 8, 0.2, 'Opus 5.5'],
    ['claude-opus-5', 5, 25, 6.25, 10, 0.5, 'Opus 5'],
    ['claude-sonnet-5-5', 2, 10, 2.5, 4, 0.2, 'Sonnet 5.5'],
    ['claude-sonnet-5', 2, 10, 2.5, 4, 0.2, 'Sonnet 5'],
    ['claude-haiku-5-5', 0.1, 0.5, 0.125, 0.2, 0.01, 'Haiku 5.5'],
    ['claude-fable-5-1', 10, 50, 12.5, 20, 0.25, 'Fable 5.1'],
    ['claude-fable-5', 10, 50, 12.5, 20, 1, 'Fable 5'],
  ])('prices %s by its own row, never a shorter key', (model, input, output, write5m, write1h, read, label) => {
    expect(calculateCost(model, M, 0, 0, 0, 0)).toBeCloseTo(input, 10);
    expect(calculateCost(model, 0, M, 0, 0, 0)).toBeCloseTo(output, 10);
    expect(calculateCost(model, 0, 0, M, 0, 0)).toBeCloseTo(write5m, 10);
    expect(calculateCost(model, 0, 0, 0, M, 0)).toBeCloseTo(write1h, 10);
    expect(calculateCost(model, 0, 0, 0, 0, M)).toBeCloseTo(read, 10);
    expect(formatModelDisplayName(model)).toBe(label);
  });

  it('reads the key through a date suffix and a context tag', () => {
    expect(calculateCost('claude-opus-5-5-20261001', M, 0, 0, 0, 0)).toBeCloseTo(4, 10);
    expect(calculateCost('claude-opus-5-5[1m]', M, 0, 0, 0, 0)).toBeCloseTo(4, 10);
  });

  it('reads the key through a Bedrock id that carries both a date and a version', () => {
    expect(calculateCost('us.anthropic.claude-sonnet-4-5-20250929-v1:0', M, 0, 0, 0, 0)).toBeCloseTo(
      calculateCost('claude-sonnet-4-5', M, 0, 0, 0, 0)!, 10);
    expect(normalizeModelName('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5');
  });

  it('gives the stats overview and spend one cost for claude-opus-5-5', () => {
    const model = 'claude-opus-5-5';
    const day = new Date().toISOString().slice(0, 10);
    const tokens = { input: 1200, output: 340, cacheRead: 90_000, cacheCreation: 5_000, cacheCreation5m: 3_000, cacheCreation1h: 2_000 };
    const cache = {
      version: 3, lastComputedDate: day, dailyActivity: [], dailyModelTokens: [{ date: day, tokensByModel: { [model]: tokens } }],
      modelUsage: {}, totalSessions: 0, totalMessages: 0, longestSession: { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
      firstSessionDate: day, hourCounts: {}, dayHourCounts: {}, totalSpeculationTimeSavedMs: 0,
    } as IStatsCache;
    const overview = buildOverview(cache, '7d') as unknown as { totalCost: number };
    const spend = buildSpendView({
      usage: [{ providerId: 'claude', workspaceId: 'ws', sessionId: 's', day, model, sidechain: false, input: tokens.input,
        output: tokens.output, cacheRead: tokens.cacheRead, cacheCreation: tokens.cacheCreation,
        cacheCreation5m: tokens.cacheCreation5m, cacheCreation1h: tokens.cacheCreation1h }],
      bindings: {}, workspaces: [], workspaceId: 'all', from: day, to: day, by: 'model', generatedAt: 0,
      index: { state: 'ready', filesIndexed: 1, filesTotal: 1, indexedThrough: 1 },
    });
    expect(spend.totals.costUsd).not.toBeNull();
    expect(overview.totalCost).toBeCloseTo(spend.totals.costUsd!, 12);
    expect(calculateCostByFullId(model, 1200, 340, 3_000, 2_000, 90_000)).toBeCloseTo(spend.totals.costUsd!, 12);
    expect(spend.totals.unpricedTokens).toBe(0);
  });
});
