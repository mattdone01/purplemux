import { describe, expect, it } from 'vitest';
import {
  addProviderUsage,
  createEmptyByProvider,
  createEmptyProviderUsage,
  sumProviderModelTokens,
} from '@/lib/stats/provider-usage';
import type { IOverviewResponse } from '@/types/stats';

const modelTokens: IOverviewResponse['modelTokens'] = {
  'claude-sonnet-4-5-20250929': {
    input: 100, output: 20, cacheRead: 300, cacheCreation: 40, cacheCreation5m: 30, cacheCreation1h: 10, cost: 1.5,
  },
  'claude-opus-4-6': {
    input: 10, output: 2, cacheRead: 3, cacheCreation: 4, cacheCreation5m: 4, cacheCreation1h: 0, cost: 0.5,
    provider: 'claude', model: 'claude-opus-4-6',
  },
  'codex:gpt-5': {
    input: 70, output: 8, cacheRead: 12, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0, cost: 0.25,
    provider: 'codex', model: 'gpt-5', cachedInput: 12,
  },
  'grok:grok-4.20': {
    input: 5, output: 1, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0, cost: 0.125,
    provider: 'grok', model: 'grok-4.20',
  },
};

describe('createEmptyByProvider', () => {
  it('carries a zeroed bucket for every provider', () => {
    const empty = createEmptyByProvider();
    expect(Object.keys(empty).sort()).toEqual(['claude', 'codex', 'grok']);
    for (const usage of Object.values(empty)) {
      expect(usage).toEqual({
        totalCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        sessions: 0,
        messages: 0,
      });
    }
  });

  it('does not share bucket identity between providers', () => {
    const empty = createEmptyByProvider();
    expect(empty.claude).not.toBe(empty.codex);
    expect(empty.codex).not.toBe(empty.grok);
  });
});

describe('sumProviderModelTokens', () => {
  it('attributes untagged model entries to claude', () => {
    expect(sumProviderModelTokens(modelTokens, 'claude')).toEqual({
      inputTokens: 110,
      outputTokens: 22,
      cacheReadTokens: 303,
      cacheCreationTokens: 44,
    });
  });

  it('sums only the requested provider', () => {
    expect(sumProviderModelTokens(modelTokens, 'codex')).toEqual({
      inputTokens: 70,
      outputTokens: 8,
      cacheReadTokens: 12,
      cacheCreationTokens: 0,
    });
    expect(sumProviderModelTokens(modelTokens, 'grok')).toEqual({
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('returns zeros for a provider with no rows', () => {
    expect(sumProviderModelTokens({}, 'grok')).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('splits the model rows without double counting', () => {
    const providers = ['claude', 'codex', 'grok'] as const;
    const summed = providers.reduce(
      (sum, provider) => sum + sumProviderModelTokens(modelTokens, provider).inputTokens,
      0,
    );
    const total = Object.values(modelTokens).reduce((sum, entry) => sum + entry.input, 0);
    expect(summed).toBe(total);
  });
});

describe('addProviderUsage', () => {
  it('accumulates a delta into one bucket only', () => {
    const result = addProviderUsage(createEmptyByProvider(), 'codex', {
      totalCost: 0.25,
      inputTokens: 70,
      sessions: 2,
      messages: 9,
    });
    expect(result.codex).toEqual({
      totalCost: 0.25,
      inputTokens: 70,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      sessions: 2,
      messages: 9,
    });
    expect(result.claude).toEqual(createEmptyProviderUsage());
    expect(result.grok).toEqual(createEmptyProviderUsage());
  });

  it('adds on top of an existing bucket', () => {
    const once = addProviderUsage(createEmptyByProvider(), 'grok', { totalCost: 1, messages: 3 });
    const twice = addProviderUsage(once, 'grok', { totalCost: 0.5, messages: 4 });
    expect(twice.grok.totalCost).toBeCloseTo(1.5, 10);
    expect(twice.grok.messages).toBe(7);
  });

  it('does not mutate the input', () => {
    const base = createEmptyByProvider();
    addProviderUsage(base, 'claude', { totalCost: 9, sessions: 9 });
    expect(base.claude).toEqual(createEmptyProviderUsage());
  });
});
