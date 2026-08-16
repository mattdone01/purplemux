import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dayjs from 'dayjs';
import type {
  IStatsCache,
  IStatsCacheDailyActivity,
  IStatsCacheDailyTokens,
  IStatsCacheModelUsage,
  IStatsCacheLongestSession,
  ITokenBreakdown,
  IOverviewResponse,
  TPeriod,
} from '@/types/stats';
import { isDateStringWithinPeriod } from './period-filter';
import { calculateCostByFullId } from '@/lib/claude-tokens';
import { addProviderUsage, createEmptyByProvider, sumProviderModelTokens } from './provider-usage';

const STATS_CACHE_PATH = path.join(os.homedir(), '.claude', 'stats-cache.json');

const estimateCostFromUsage = (
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation5m: number,
  cacheCreation1h: number,
): number => calculateCostByFullId(model, input, output, cacheCreation5m, cacheCreation1h, cacheRead);

const EMPTY_CACHE: IStatsCache = {
  version: 0,
  lastComputedDate: '',
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
};

const safeParseDailyActivity = (raw: unknown): IStatsCacheDailyActivity[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      date: String(item.date ?? ''),
      messageCount: Number(item.messageCount ?? 0),
      sessionCount: Number(item.sessionCount ?? 0),
      toolCallCount: Number(item.toolCallCount ?? 0),
    }));
};

const parseTokenBreakdown = (v: unknown): ITokenBreakdown => {
  if (typeof v === 'number') {
    return { input: v, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0 };
  }
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    const cacheCreation = Number(o.cacheCreation ?? 0);
    const cacheCreation1h = Number(o.cacheCreation1h ?? 0);
    const cacheCreation5m = o.cacheCreation5m != null
      ? Number(o.cacheCreation5m)
      : Math.max(0, cacheCreation - cacheCreation1h);
    return {
      input: Number(o.input ?? 0),
      output: Number(o.output ?? 0),
      cacheRead: Number(o.cacheRead ?? 0),
      cacheCreation,
      cacheCreation5m,
      cacheCreation1h,
    };
  }
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0 };
};

const safeParseDailyTokens = (raw: unknown): IStatsCacheDailyTokens[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      date: String(item.date ?? ''),
      tokensByModel: typeof item.tokensByModel === 'object' && item.tokensByModel !== null
        ? Object.fromEntries(
            Object.entries(item.tokensByModel as Record<string, unknown>).map(([k, v]) => [k, parseTokenBreakdown(v)]),
          )
        : {},
    }));
};

const safeParseModelUsage = (raw: unknown): Record<string, IStatsCacheModelUsage> => {
  if (typeof raw !== 'object' || raw === null) return {};
  const result: Record<string, IStatsCacheModelUsage> = {};
  for (const [model, usage] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof usage !== 'object' || usage === null) continue;
    const u = usage as Record<string, unknown>;
    const cacheCreationTotal = Number(u.cacheCreationInputTokens ?? 0);
    const cacheCreation1h = Number(u.cacheCreation1hInputTokens ?? 0);
    const cacheCreation5m = u.cacheCreation5mInputTokens != null
      ? Number(u.cacheCreation5mInputTokens)
      : Math.max(0, cacheCreationTotal - cacheCreation1h);
    result[model] = {
      inputTokens: Number(u.inputTokens ?? 0),
      outputTokens: Number(u.outputTokens ?? 0),
      cacheReadInputTokens: Number(u.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: cacheCreationTotal,
      cacheCreation5mInputTokens: cacheCreation5m,
      cacheCreation1hInputTokens: cacheCreation1h,
      webSearchRequests: Number(u.webSearchRequests ?? 0),
      costUSD: Number(u.costUSD ?? 0),
      contextWindow: Number(u.contextWindow ?? 0),
      maxOutputTokens: Number(u.maxOutputTokens ?? 0),
    };
  }
  return result;
};

const safeParseLongestSession = (raw: unknown): IStatsCacheLongestSession => {
  if (typeof raw !== 'object' || raw === null) {
    return { sessionId: '', duration: 0, messageCount: 0, timestamp: '' };
  }
  const r = raw as Record<string, unknown>;
  return {
    sessionId: String(r.sessionId ?? ''),
    duration: Number(r.duration ?? 0),
    messageCount: Number(r.messageCount ?? 0),
    timestamp: String(r.timestamp ?? ''),
  };
};

const safeParseHourCounts = (raw: unknown): Record<string, number> => {
  if (typeof raw !== 'object' || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, Number(v ?? 0)]),
  );
};

export const readStatsCache = async (): Promise<IStatsCache> => {
  try {
    const content = await fs.readFile(STATS_CACHE_PATH, 'utf-8');
    const raw = JSON.parse(content) as Record<string, unknown>;
    return {
      version: Number(raw.version ?? 0),
      lastComputedDate: String(raw.lastComputedDate ?? ''),
      dailyActivity: safeParseDailyActivity(raw.dailyActivity),
      dailyModelTokens: safeParseDailyTokens(raw.dailyModelTokens),
      modelUsage: safeParseModelUsage(raw.modelUsage),
      totalSessions: Number(raw.totalSessions ?? 0),
      totalMessages: Number(raw.totalMessages ?? 0),
      longestSession: safeParseLongestSession(raw.longestSession),
      firstSessionDate: String(raw.firstSessionDate ?? ''),
      hourCounts: safeParseHourCounts(raw.hourCounts),
      dayHourCounts: safeParseHourCounts(raw.dayHourCounts),
      totalSpeculationTimeSavedMs: Number(raw.totalSpeculationTimeSavedMs ?? 0),
    };
  } catch {
    return EMPTY_CACHE;
  }
};

export const buildOverview = (cache: IStatsCache, period: TPeriod): IOverviewResponse => {
  const filteredDaily = cache.dailyActivity.filter((d) => isDateStringWithinPeriod(d.date, period));
  const filteredTokens = cache.dailyModelTokens.filter((d) => isDateStringWithinPeriod(d.date, period));

  const totalSessions = period === 'all'
    ? cache.totalSessions
    : filteredDaily.reduce((sum, d) => sum + d.sessionCount, 0);

  const totalMessages = period === 'all'
    ? cache.totalMessages
    : filteredDaily.reduce((sum, d) => sum + d.messageCount, 0);

  const totalToolCalls = filteredDaily.reduce((sum, d) => sum + d.toolCallCount, 0);

  const previousDaily = getPreviousPeriodDaily(cache.dailyActivity, period);
  const previousSessions = previousDaily.reduce((sum, d) => sum + d.sessionCount, 0);
  const previousMessages = previousDaily.reduce((sum, d) => sum + d.messageCount, 0);

  const modelTokens: Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number; cacheCreation5m: number; cacheCreation1h: number; cost: number }> = {};
  if (period === 'all') {
    for (const [model, usage] of Object.entries(cache.modelUsage)) {
      modelTokens[model] = {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadInputTokens,
        cacheCreation: usage.cacheCreationInputTokens,
        cacheCreation5m: usage.cacheCreation5mInputTokens,
        cacheCreation1h: usage.cacheCreation1hInputTokens,
        cost: estimateCostFromUsage(
          model,
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadInputTokens,
          usage.cacheCreation5mInputTokens,
          usage.cacheCreation1hInputTokens,
        ),
      };
    }
  } else {
    for (const day of filteredTokens) {
      for (const [model, breakdown] of Object.entries(day.tokensByModel)) {
        if (!modelTokens[model]) {
          modelTokens[model] = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0, cost: 0 };
        }
        modelTokens[model].input += breakdown.input;
        modelTokens[model].output += breakdown.output;
        modelTokens[model].cacheRead += breakdown.cacheRead;
        modelTokens[model].cacheCreation += breakdown.cacheCreation;
        modelTokens[model].cacheCreation5m += breakdown.cacheCreation5m;
        modelTokens[model].cacheCreation1h += breakdown.cacheCreation1h;
      }
    }

    for (const [model, tokens] of Object.entries(modelTokens)) {
      tokens.cost = estimateCostFromUsage(
        model,
        tokens.input,
        tokens.output,
        tokens.cacheRead,
        tokens.cacheCreation5m,
        tokens.cacheCreation1h,
      );
    }
  }

  const dailyTokens = filteredTokens.map((d) => {
    let input = 0, output = 0, cacheRead = 0, cacheCreation = 0;
    for (const breakdown of Object.values(d.tokensByModel)) {
      input += breakdown.input;
      output += breakdown.output;
      cacheRead += breakdown.cacheRead;
      cacheCreation += breakdown.cacheCreation;
    }
    return { date: d.date, input, output, cacheRead, cacheCreation };
  });

  const today = dayjs().format('YYYY-MM-DD');
  const startOfMonth = dayjs().startOf('month').format('YYYY-MM-DD');
  const todayMessages = cache.dailyActivity.find((d) => d.date === today)?.messageCount ?? 0;
  const thisMonthMessages = cache.dailyActivity
    .filter((d) => d.date >= startOfMonth)
    .reduce((sum, d) => sum + d.messageCount, 0);

  const totalCost = Object.values(modelTokens).reduce((sum, m) => sum + m.cost, 0);

  const estimateCostForDates = (dates: IStatsCacheDailyTokens[]): number => {
    let cost = 0;
    for (const day of dates) {
      for (const [model, breakdown] of Object.entries(day.tokensByModel)) {
        cost += estimateCostFromUsage(
          model,
          breakdown.input,
          breakdown.output,
          breakdown.cacheRead,
          breakdown.cacheCreation5m,
          breakdown.cacheCreation1h,
        );
      }
    }
    return cost;
  };

  const todayCost = estimateCostForDates(
    cache.dailyModelTokens.filter((d) => d.date === today),
  );
  const thisMonthCost = estimateCostForDates(
    cache.dailyModelTokens.filter((d) => d.date >= startOfMonth),
  );
  const previousCost = estimateCostForDates(
    getPreviousPeriodTokens(cache.dailyModelTokens, period),
  );

  const byProvider = addProviderUsage(createEmptyByProvider(), 'claude', {
    ...sumProviderModelTokens(modelTokens, 'claude'),
    totalCost,
    sessions: totalSessions,
    messages: totalMessages,
  });

  return {
    byProvider,
    totalSessions,
    totalMessages,
    previousSessions,
    previousMessages,
    totalToolCalls,
    dailyActivity: filteredDaily,
    modelTokens,
    dailyTokens,
    todayMessages,
    thisMonthMessages,
    totalCost,
    todayCost,
    thisMonthCost,
    previousCost,
    hourlyDistribution: cache.hourCounts,
    dayHourDistribution: cache.dayHourCounts,
    firstSessionDate: cache.firstSessionDate,
    lastComputedDate: cache.lastComputedDate,
    computedAt: new Date().toISOString(),
  };
};

const getPreviousPeriodRange = (period: TPeriod): { prevStart: dayjs.Dayjs; prevEnd: dayjs.Dayjs } | null => {
  if (period === 'all' || period === 'today') return null;
  const days = period === '7d' ? 7 : 30;
  return {
    prevStart: dayjs().subtract(days * 2, 'day').startOf('day'),
    prevEnd: dayjs().subtract(days, 'day').startOf('day'),
  };
};

const isInPreviousPeriod = (dateStr: string, period: TPeriod): boolean => {
  const range = getPreviousPeriodRange(period);
  if (!range) return false;
  const date = dayjs(dateStr);
  return (date.isAfter(range.prevStart) || date.isSame(range.prevStart)) && date.isBefore(range.prevEnd);
};

const getPreviousPeriodDaily = (
  allDaily: IStatsCacheDailyActivity[],
  period: TPeriod,
): IStatsCacheDailyActivity[] => {
  return allDaily.filter((d) => isInPreviousPeriod(d.date, period));
};

const getPreviousPeriodTokens = (
  allTokens: IStatsCacheDailyTokens[],
  period: TPeriod,
): IStatsCacheDailyTokens[] => {
  return allTokens.filter((d) => isInPreviousPeriod(d.date, period));
};
