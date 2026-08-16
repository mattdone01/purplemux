import { beforeEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ICodexProviderStats, ICodexHistoryEntry } from '@/lib/stats/jsonl-parser-codex';
import type { IGrokUsageSummary } from '@/lib/stats/grok-usage';
import type { IOverviewResponse, ISessionStats, IStatsCache, TStatsProvider } from '@/types/stats';

const TODAY = dayjs().format('YYYY-MM-DD');
const NOW_MS = dayjs(`${TODAY}T09:00:00`).valueOf();
const NOW_ISO = dayjs(NOW_MS).toISOString();

const emptyStatsCache = (): IStatsCache => ({
  version: 3,
  lastComputedDate: TODAY,
  dailyActivity: [],
  dailyModelTokens: [],
  modelUsage: {},
  totalSessions: 0,
  totalMessages: 0,
  longestSession: { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
  firstSessionDate: '',
  hourCounts: {},
  dayHourCounts: {},
  totalSpeculationTimeSavedMs: 0,
});

const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';

const claudeStatsCache = (): IStatsCache => ({
  ...emptyStatsCache(),
  dailyActivity: [{ date: TODAY, messageCount: 12, sessionCount: 3, toolCallCount: 5 }],
  dailyModelTokens: [{
    date: TODAY,
    tokensByModel: {
      [CLAUDE_MODEL]: {
        input: 1000, output: 200, cacheRead: 5000, cacheCreation: 400, cacheCreation5m: 300, cacheCreation1h: 100,
      },
    },
  }],
  modelUsage: {
    [CLAUDE_MODEL]: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 400,
      cacheCreation5mInputTokens: 300,
      cacheCreation1hInputTokens: 100,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 0,
      maxOutputTokens: 0,
    },
  },
  totalSessions: 3,
  totalMessages: 12,
  firstSessionDate: TODAY,
  hourCounts: { '9': 12 },
  dayHourCounts: { [`${dayjs(NOW_MS).day()}-9`]: 12 },
});

const codexSessionStats = (): ICodexProviderStats['sessions'] => ([
  {
    sessionId: 'codex-1',
    jsonlPath: '/tmp/codex-1.jsonl',
    startedAt: NOW_MS,
    cwd: '/home/dev/project',
    model: 'gpt-5-codex',
    inputTokens: 900,
    cachedInputTokens: 300,
    outputTokens: 150,
    reasoningOutputTokens: 40,
    totalTokens: 1050,
    currentContextTokens: 0,
    contextWindowSize: 0,
    usedPercentage: null,
    cost: 0.42,
    extras: null,
  },
  {
    sessionId: 'codex-2',
    jsonlPath: '/tmp/codex-2.jsonl',
    startedAt: NOW_MS,
    cwd: '/home/dev/project',
    model: 'gpt-5-codex',
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 30,
    reasoningOutputTokens: 0,
    totalTokens: 130,
    currentContextTokens: 0,
    contextWindowSize: 0,
    usedPercentage: null,
    cost: 0.08,
    extras: null,
  },
]);

const codexSessions = (): ISessionStats[] => ([
  {
    sessionId: 'codex-1',
    project: 'project',
    startedAt: NOW_ISO,
    lastActivityAt: NOW_ISO,
    messageCount: 3,
    totalTokens: 1050,
    model: 'gpt-5-codex',
  },
  {
    sessionId: 'codex-2',
    project: 'project',
    startedAt: NOW_ISO,
    lastActivityAt: NOW_ISO,
    messageCount: 1,
    totalTokens: 130,
    model: 'gpt-5-codex',
  },
]);

const codexHistory = (): ICodexHistoryEntry[] =>
  Array.from({ length: 4 }, (_, i) => ({ text: `prompt ${i}`, timestamp: NOW_MS + i }));

const grokUsage = (): IGrokUsageSummary => ({
  sessions: [
    {
      sessionId: 'grok-1',
      startedAt: NOW_ISO,
      model: 'grok-4.20',
      inputTokens: 400,
      outputTokens: 90,
      cost: 0.19,
      messageCount: 2,
    },
  ],
  messageTimestamps: [NOW_MS, NOW_MS + 1000],
});

const EMPTY_GROK: IGrokUsageSummary = { sessions: [], messageTimestamps: [] };

const state = vi.hoisted(() => ({
  statsCache: null as unknown,
  codexSessions: [] as unknown[],
  codexHistory: [] as unknown[],
  codexStats: null as unknown,
  grokUsage: null as unknown,
}));

vi.mock('@/lib/stats/stats-cache', () => ({
  getStatsCache: async () => state.statsCache,
}));

vi.mock('@/lib/stats/jsonl-parser-codex', () => ({
  parseCodexSessions: async () => state.codexSessions,
  parseCodexHistory: async () => state.codexHistory,
  parseCodexJsonl: async () => state.codexStats,
}));

vi.mock('@/lib/stats/grok-usage', () => ({
  readGrokUsage: () => state.grokUsage,
}));

const { default: handler } = await import('@/pages/api/stats/overview');
const { buildOverview } = await import('@/lib/stats/stats-cache-parser');
const { invalidateCache } = await import('@/lib/stats/cache');

interface IFakeResponse {
  statusCode: number;
  body: IOverviewResponse;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
  const state: IFakeResponse = { statusCode: 0, body: undefined as unknown as IOverviewResponse, res: undefined as unknown as NextApiResponse };
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload as IOverviewResponse;
      return this;
    },
    setHeader() {
      return this;
    },
  } as unknown as NextApiResponse;
  return state;
};

const callOverview = async (period: string): Promise<IOverviewResponse> => {
  const response = fakeResponse();
  await handler({ method: 'GET', query: { period } } as unknown as NextApiRequest, response.res);
  expect(response.statusCode).toBe(200);
  return response.body;
};

const PROVIDERS: TStatsProvider[] = ['claude', 'codex', 'grok'];

const sumBy = (body: IOverviewResponse, field: keyof IOverviewResponse['byProvider']['claude']): number =>
  PROVIDERS.reduce((sum, provider) => sum + body.byProvider[provider][field], 0);

const sumModelTokens = (body: IOverviewResponse, field: 'input' | 'output' | 'cacheRead' | 'cacheCreation'): number =>
  Object.values(body.modelTokens).reduce((sum, entry) => sum + entry[field], 0);

beforeEach(() => {
  invalidateCache();
  state.statsCache = claudeStatsCache();
  state.codexSessions = codexSessions();
  state.codexHistory = codexHistory();
  state.codexStats = { daily: [], totals: { tokens: 0, tokensWithCached: 0, sessions: 0, cachedInputTokens: 0 }, extras: null, sessions: codexSessionStats() };
  state.grokUsage = grokUsage();
});

describe('buildOverview byProvider', () => {
  it('reports the claude bucket and leaves the other providers at zero', () => {
    const overview = buildOverview(claudeStatsCache(), 'all');

    expect(overview.byProvider.claude).toEqual({
      totalCost: overview.totalCost,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheCreationTokens: 400,
      sessions: 3,
      messages: 12,
    });
    expect(overview.byProvider.codex).toEqual({
      totalCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, sessions: 0, messages: 0,
    });
    expect(overview.byProvider.grok).toEqual(overview.byProvider.codex);
    expect(overview.byProvider.claude.totalCost).toBeGreaterThan(0);
  });

  it('carries a byProvider block for an empty stats cache', () => {
    const overview = buildOverview(emptyStatsCache(), '7d');
    for (const provider of PROVIDERS) {
      expect(overview.byProvider[provider]).toEqual({
        totalCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, sessions: 0, messages: 0,
      });
    }
  });
});

describe('GET /api/stats/overview byProvider', () => {
  for (const period of ['today', '7d', '30d', 'all']) {
    it(`splits the headline scalars across the three providers for period=${period}`, async () => {
      const body = await callOverview(period);

      expect(Object.keys(body.byProvider).sort()).toEqual(['claude', 'codex', 'grok']);
      for (const provider of PROVIDERS) {
        expect(Object.keys(body.byProvider[provider]).sort()).toEqual([
          'cacheCreationTokens', 'cacheReadTokens', 'inputTokens', 'messages', 'outputTokens', 'sessions', 'totalCost',
        ]);
      }

      expect(sumBy(body, 'totalCost')).toBeCloseTo(body.totalCost, 6);
      expect(sumBy(body, 'sessions')).toBe(body.totalSessions);
      expect(sumBy(body, 'messages')).toBe(body.totalMessages);
      expect(sumBy(body, 'inputTokens')).toBe(sumModelTokens(body, 'input'));
      expect(sumBy(body, 'outputTokens')).toBe(sumModelTokens(body, 'output'));
      expect(sumBy(body, 'cacheReadTokens')).toBe(sumModelTokens(body, 'cacheRead'));
      expect(sumBy(body, 'cacheCreationTokens')).toBe(sumModelTokens(body, 'cacheCreation'));

      for (const provider of PROVIDERS) {
        expect(body.byProvider[provider].totalCost).toBeGreaterThan(0);
      }
    });
  }

  it('attributes codex tokens net of its cached input', async () => {
    const body = await callOverview('all');

    expect(body.byProvider.codex).toEqual({
      totalCost: 0.5,
      inputTokens: 680,
      outputTokens: 180,
      cacheReadTokens: 320,
      cacheCreationTokens: 0,
      sessions: 2,
      messages: 4,
    });
  });

  it('attributes grok tokens with no cache counters', async () => {
    const body = await callOverview('all');

    expect(body.byProvider.grok).toEqual({
      totalCost: 0.19,
      inputTokens: 400,
      outputTokens: 90,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      sessions: 1,
      messages: 2,
    });
  });

  it('keeps a zeroed codex bucket when the box has no codex data', async () => {
    state.codexSessions = [];
    state.codexHistory = [];
    state.codexStats = { daily: [], totals: { tokens: 0, tokensWithCached: 0, sessions: 0, cachedInputTokens: 0 }, extras: null, sessions: [] };

    const body = await callOverview('all');

    expect(body.byProvider.codex).toEqual({
      totalCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, sessions: 0, messages: 0,
    });
    expect(sumBy(body, 'totalCost')).toBeCloseTo(body.totalCost, 6);
  });

  it('keeps a zeroed grok bucket when the box has no grok data', async () => {
    state.grokUsage = EMPTY_GROK;

    const body = await callOverview('all');

    expect(body.byProvider.grok).toEqual({
      totalCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, sessions: 0, messages: 0,
    });
    expect(sumBy(body, 'sessions')).toBe(body.totalSessions);
    expect(sumBy(body, 'messages')).toBe(body.totalMessages);
  });

  it('leaves the existing overview fields in place', async () => {
    const body = await callOverview('all');

    for (const field of [
      'totalSessions', 'totalMessages', 'previousSessions', 'previousMessages', 'totalToolCalls',
      'dailyActivity', 'modelTokens', 'dailyTokens', 'hourlyDistribution', 'dayHourDistribution',
      'todayMessages', 'thisMonthMessages', 'totalCost', 'todayCost', 'thisMonthCost', 'previousCost',
      'firstSessionDate', 'lastComputedDate', 'computedAt',
    ]) {
      expect(body).toHaveProperty(field);
    }
    expect(body.modelTokens[`codex:gpt-5-codex`]?.provider).toBe('codex');
    expect(body.modelTokens[`grok:grok-4.20`]?.provider).toBe('grok');
  });
});
