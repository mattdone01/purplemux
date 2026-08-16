import type { NextApiRequest, NextApiResponse } from 'next';
import dayjs from 'dayjs';
import { getStatsCache } from '@/lib/stats/stats-cache';
import { buildOverview } from '@/lib/stats/stats-cache-parser';
import { parseCodexHistory, parseCodexJsonl, parseCodexSessions } from '@/lib/stats/jsonl-parser-codex';
import { readGrokUsage, type IGrokUsageSummary } from '@/lib/stats/grok-usage';
import { parsePeriod } from '@/lib/stats/period-filter';
import { getCached, setCached } from '@/lib/stats/cache';
import { addProviderUsage, sumProviderModelTokens } from '@/lib/stats/provider-usage';
import type { IOverviewResponse, IStatsCacheDailyActivity, TPeriod } from '@/types/stats';

type TOverviewModelTokens = IOverviewResponse['modelTokens'][string];
type TOverviewDailyTokens = IOverviewResponse['dailyTokens'][number];

const mergeDailyActivity = (
  base: IStatsCacheDailyActivity[],
  additions: IStatsCacheDailyActivity[],
): IStatsCacheDailyActivity[] => {
  const map = new Map<string, IStatsCacheDailyActivity>();
  for (const day of base) {
    map.set(day.date, {
      ...day,
      claudeMessageCount: day.claudeMessageCount ?? day.messageCount,
      codexMessageCount: day.codexMessageCount ?? 0,
      claudeSessionCount: day.claudeSessionCount ?? day.sessionCount,
      codexSessionCount: day.codexSessionCount ?? 0,
      grokMessageCount: day.grokMessageCount ?? 0,
      grokSessionCount: day.grokSessionCount ?? 0,
    });
  }
  for (const day of additions) {
    const existing = map.get(day.date);
    if (existing) {
      existing.messageCount += day.messageCount;
      existing.sessionCount += day.sessionCount;
      existing.toolCallCount += day.toolCallCount;
      existing.claudeMessageCount = existing.claudeMessageCount ?? 0;
      existing.codexMessageCount = (existing.codexMessageCount ?? 0) + (day.codexMessageCount ?? day.messageCount);
      existing.claudeSessionCount = existing.claudeSessionCount ?? 0;
      existing.codexSessionCount = (existing.codexSessionCount ?? 0) + (day.codexSessionCount ?? day.sessionCount);
      existing.grokMessageCount = (existing.grokMessageCount ?? 0) + (day.grokMessageCount ?? 0);
      existing.grokSessionCount = (existing.grokSessionCount ?? 0) + (day.grokSessionCount ?? 0);
    } else {
      map.set(day.date, {
        ...day,
        claudeMessageCount: day.claudeMessageCount ?? 0,
        codexMessageCount: day.codexMessageCount ?? day.messageCount,
        claudeSessionCount: day.claudeSessionCount ?? 0,
        codexSessionCount: day.codexSessionCount ?? day.sessionCount,
        grokMessageCount: day.grokMessageCount ?? 0,
        grokSessionCount: day.grokSessionCount ?? 0,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
};

/**
 * grok's additions are merged on their own path: `mergeDailyActivity` carries
 * codex fallbacks that would otherwise attribute grok's messages to codex.
 */
const mergeGrokDailyActivity = (
  base: IStatsCacheDailyActivity[],
  additions: IStatsCacheDailyActivity[],
): IStatsCacheDailyActivity[] => {
  const map = new Map<string, IStatsCacheDailyActivity>();
  for (const day of base) map.set(day.date, { ...day });
  for (const day of additions) {
    const existing = map.get(day.date);
    if (existing) {
      existing.messageCount += day.messageCount;
      existing.sessionCount += day.sessionCount;
      existing.toolCallCount += day.toolCallCount;
      existing.grokMessageCount = (existing.grokMessageCount ?? 0) + (day.grokMessageCount ?? 0);
      existing.grokSessionCount = (existing.grokSessionCount ?? 0) + (day.grokSessionCount ?? 0);
    } else {
      map.set(day.date, { ...day });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
};

const getGrokDailyActivity = (usage: IGrokUsageSummary): IStatsCacheDailyActivity[] => {
  const map = new Map<string, IStatsCacheDailyActivity>();
  const dayFor = (date: string): IStatsCacheDailyActivity => {
    const day = map.get(date) ?? {
      date,
      messageCount: 0,
      sessionCount: 0,
      toolCallCount: 0,
      claudeMessageCount: 0,
      codexMessageCount: 0,
      grokMessageCount: 0,
      claudeSessionCount: 0,
      codexSessionCount: 0,
      grokSessionCount: 0,
    };
    map.set(date, day);
    return day;
  };

  for (const session of usage.sessions) {
    const day = dayFor(session.startedAt.slice(0, 10));
    day.sessionCount += 1;
    day.grokSessionCount = (day.grokSessionCount ?? 0) + 1;
  }
  for (const timestamp of usage.messageTimestamps) {
    const day = dayFor(dayjs(timestamp).format('YYYY-MM-DD'));
    day.messageCount += 1;
    day.grokMessageCount = (day.grokMessageCount ?? 0) + 1;
  }
  return Array.from(map.values());
};

const getGrokTokenBreakdown = (usage: IGrokUsageSummary): {
  modelTokens: IOverviewResponse['modelTokens'];
  dailyTokens: IOverviewResponse['dailyTokens'];
} => {
  const modelTokens: IOverviewResponse['modelTokens'] = {};
  const dailyMap = new Map<string, TOverviewDailyTokens>();

  for (const session of usage.sessions) {
    const model = session.model ?? null;
    const key = `grok:${model ?? 'unknown'}`;
    if (!modelTokens[key]) {
      modelTokens[key] = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
        cacheCreation5m: 0,
        cacheCreation1h: 0,
        cost: 0,
        provider: 'grok',
        model,
      };
    }
    const entry = modelTokens[key] as TOverviewModelTokens;
    entry.input += session.inputTokens;
    entry.output += session.outputTokens;
    entry.cacheRead += session.cacheReadTokens;
    entry.cacheCreation += session.cacheCreationTokens;
    entry.cost += session.cost;

    const date = dayjs(session.startedAt).format('YYYY-MM-DD');
    const day = dailyMap.get(date) ?? { date, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    day.input += session.inputTokens;
    day.output += session.outputTokens;
    day.cacheRead += session.cacheReadTokens;
    day.cacheCreation += session.cacheCreationTokens;
    dailyMap.set(date, day);
  }

  return {
    modelTokens,
    dailyTokens: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
  };
};

const getGrokHourCounts = (usage: IGrokUsageSummary) => {
  const hourCounts: Record<string, number> = {};
  const dayHourCounts: Record<string, number> = {};
  for (const timestamp of usage.messageTimestamps) {
    const d = dayjs(timestamp);
    const hour = String(d.hour());
    hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
    dayHourCounts[`${d.day()}-${hour}`] = (dayHourCounts[`${d.day()}-${hour}`] ?? 0) + 1;
  }
  return { hourCounts, dayHourCounts };
};

const getCodexDailyActivity = (
  sessions: Awaited<ReturnType<typeof parseCodexSessions>>,
  history: Awaited<ReturnType<typeof parseCodexHistory>>,
): IStatsCacheDailyActivity[] => {
  const map = new Map<string, IStatsCacheDailyActivity>();
  for (const session of sessions) {
    const date = session.startedAt.slice(0, 10);
    const day = map.get(date) ?? {
      date,
      messageCount: 0,
      sessionCount: 0,
      toolCallCount: 0,
      claudeMessageCount: 0,
      codexMessageCount: 0,
      claudeSessionCount: 0,
      codexSessionCount: 0,
    };
    day.sessionCount++;
    day.codexSessionCount = (day.codexSessionCount ?? 0) + 1;
    map.set(date, day);
  }
  for (const entry of history) {
    const date = dayjs(entry.timestamp).format('YYYY-MM-DD');
    const day = map.get(date) ?? {
      date,
      messageCount: 0,
      sessionCount: 0,
      toolCallCount: 0,
      claudeMessageCount: 0,
      codexMessageCount: 0,
      claudeSessionCount: 0,
      codexSessionCount: 0,
    };
    day.messageCount++;
    day.codexMessageCount = (day.codexMessageCount ?? 0) + 1;
    map.set(date, day);
  }
  return Array.from(map.values());
};

const mergeCounts = (base: Record<string, number>, additions: Record<string, number>): Record<string, number> => {
  const result = { ...base };
  for (const [key, value] of Object.entries(additions)) {
    result[key] = (result[key] ?? 0) + value;
  }
  return result;
};

const mergeDailyTokens = (
  base: IOverviewResponse['dailyTokens'],
  additions: IOverviewResponse['dailyTokens'],
): IOverviewResponse['dailyTokens'] => {
  const map = new Map<string, TOverviewDailyTokens>();
  for (const day of base) map.set(day.date, { ...day });
  for (const day of additions) {
    const existing = map.get(day.date);
    if (existing) {
      existing.input += day.input;
      existing.output += day.output;
      existing.cacheRead += day.cacheRead;
      existing.cacheCreation += day.cacheCreation;
    } else {
      map.set(day.date, { ...day });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
};

const mergeModelTokens = (
  base: IOverviewResponse['modelTokens'],
  additions: IOverviewResponse['modelTokens'],
): IOverviewResponse['modelTokens'] => ({ ...base, ...additions });

const getCodexTokenBreakdown = (
  sessions: Awaited<ReturnType<typeof parseCodexJsonl>>['sessions'],
): {
  modelTokens: IOverviewResponse['modelTokens'];
  dailyTokens: IOverviewResponse['dailyTokens'];
} => {
  const modelTokens: IOverviewResponse['modelTokens'] = {};
  const dailyMap = new Map<string, TOverviewDailyTokens>();

  for (const session of sessions) {
    const model = session.model ?? null;
    const key = `codex:${model ?? 'unknown'}`;
    const input = Math.max(0, session.inputTokens - session.cachedInputTokens);
    const output = session.outputTokens;
    const cachedInput = session.cachedInputTokens;

    if (!modelTokens[key]) {
      modelTokens[key] = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
        cacheCreation5m: 0,
        cacheCreation1h: 0,
        cost: 0,
        provider: 'codex',
        model,
        cachedInput: 0,
      };
    }
    const modelEntry = modelTokens[key] as TOverviewModelTokens;
    modelEntry.input += input;
    modelEntry.output += output;
    modelEntry.cacheRead += cachedInput;
    modelEntry.cost += session.cost ?? 0;
    modelEntry.cachedInput = (modelEntry.cachedInput ?? 0) + cachedInput;

    const date = dayjs(session.startedAt).format('YYYY-MM-DD');
    const day = dailyMap.get(date) ?? { date, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    day.input += input;
    day.output += output;
    day.cacheRead += cachedInput;
    dailyMap.set(date, day);
  }

  return {
    modelTokens,
    dailyTokens: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
  };
};

const getCodexHourCounts = (history: Awaited<ReturnType<typeof parseCodexHistory>>) => {
  const hourCounts: Record<string, number> = {};
  const dayHourCounts: Record<string, number> = {};
  for (const entry of history) {
    const d = dayjs(entry.timestamp);
    const hour = String(d.hour());
    hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
    const dayHourKey = `${d.day()}-${hour}`;
    dayHourCounts[dayHourKey] = (dayHourCounts[dayHourKey] ?? 0) + 1;
  }
  return { hourCounts, dayHourCounts };
};

const getPreviousPeriodRange = (period: TPeriod): { start: dayjs.Dayjs; end: dayjs.Dayjs } | null => {
  if (period === 'all' || period === 'today') return null;
  const days = period === '7d' ? 7 : 30;
  return {
    start: dayjs().subtract(days * 2, 'day').startOf('day'),
    end: dayjs().subtract(days, 'day').startOf('day'),
  };
};

const isInPreviousPeriod = (timestamp: string | number, period: TPeriod): boolean => {
  const range = getPreviousPeriodRange(period);
  if (!range) return false;
  const d = dayjs(timestamp);
  return (d.isAfter(range.start) || d.isSame(range.start)) && d.isBefore(range.end);
};

const mergeCodexOverview = async (
  overview: IOverviewResponse,
  period: TPeriod,
): Promise<IOverviewResponse> => {
  const needsPrevious = period === '7d' || period === '30d';
  const [codexSessions, codexHistory, codexStats, codexAllStats, codexAllSessions, codexAllHistory] = await Promise.all([
    parseCodexSessions(period),
    parseCodexHistory(period),
    parseCodexJsonl(period),
    needsPrevious ? parseCodexJsonl('all') : Promise.resolve(null),
    needsPrevious ? parseCodexSessions('all') : Promise.resolve(null),
    needsPrevious ? parseCodexHistory('all') : Promise.resolve(null),
  ]);

  const codexDailyActivity = getCodexDailyActivity(codexSessions, codexHistory);
  const codexTokenBreakdown = getCodexTokenBreakdown(codexStats.sessions);
  const { hourCounts, dayHourCounts } = getCodexHourCounts(codexHistory);
  const codexCost = codexStats.sessions.reduce((sum, session) => sum + (session.cost ?? 0), 0);
  const today = dayjs().format('YYYY-MM-DD');
  const monthStart = dayjs().startOf('month');
  const codexTodayCost = codexAllStats?.sessions
    .filter((session) => dayjs(session.startedAt).format('YYYY-MM-DD') === today)
    .reduce((sum, session) => sum + (session.cost ?? 0), 0)
    ?? codexStats.sessions
      .filter((session) => dayjs(session.startedAt).format('YYYY-MM-DD') === today)
      .reduce((sum, session) => sum + (session.cost ?? 0), 0);
  const codexThisMonthCost = (codexAllStats ?? codexStats).sessions
    .filter((session) => dayjs(session.startedAt).isAfter(monthStart) || dayjs(session.startedAt).isSame(monthStart))
    .reduce((sum, session) => sum + (session.cost ?? 0), 0);
  const codexTodayMessages = codexHistory.filter((entry) => dayjs(entry.timestamp).format('YYYY-MM-DD') === today).length;
  const codexThisMonthMessages = (codexAllHistory ?? codexHistory)
    .filter((entry) => dayjs(entry.timestamp).isAfter(monthStart) || dayjs(entry.timestamp).isSame(monthStart))
    .length;
  const codexFirstSessionDate = codexSessions
    .map((session) => session.startedAt.slice(0, 10))
    .sort()[0] ?? '';
  const firstSessionDate = [overview.firstSessionDate, codexFirstSessionDate]
    .filter(Boolean)
    .sort()[0] ?? '';

  const previousSessions = codexAllSessions?.filter((session) => isInPreviousPeriod(session.startedAt, period)).length ?? 0;
  const previousMessages = codexAllHistory?.filter((entry) => isInPreviousPeriod(entry.timestamp, period)).length ?? 0;
  const previousCost = codexAllStats?.sessions
    .filter((session) => isInPreviousPeriod(session.startedAt, period))
    .reduce((sum, session) => sum + (session.cost ?? 0), 0)
    ?? 0;

  return {
    ...overview,
    byProvider: addProviderUsage(overview.byProvider, 'codex', {
      ...sumProviderModelTokens(codexTokenBreakdown.modelTokens, 'codex'),
      totalCost: codexCost,
      sessions: codexSessions.length,
      messages: codexHistory.length,
    }),
    totalSessions: overview.totalSessions + codexSessions.length,
    totalMessages: overview.totalMessages + codexHistory.length,
    previousSessions: overview.previousSessions + previousSessions,
    previousMessages: overview.previousMessages + previousMessages,
    dailyActivity: mergeDailyActivity(overview.dailyActivity, codexDailyActivity),
    modelTokens: mergeModelTokens(overview.modelTokens, codexTokenBreakdown.modelTokens),
    dailyTokens: mergeDailyTokens(overview.dailyTokens, codexTokenBreakdown.dailyTokens),
    hourlyDistribution: mergeCounts(overview.hourlyDistribution, hourCounts),
    dayHourDistribution: mergeCounts(overview.dayHourDistribution, dayHourCounts),
    todayMessages: overview.todayMessages + codexTodayMessages,
    thisMonthMessages: overview.thisMonthMessages + codexThisMonthMessages,
    totalCost: overview.totalCost + codexCost,
    todayCost: overview.todayCost + codexTodayCost,
    thisMonthCost: overview.thisMonthCost + codexThisMonthCost,
    previousCost: overview.previousCost + previousCost,
    firstSessionDate,
  };
};

/**
 * grok exposes no rate-limit windows, but its `turn_completed` updates do carry
 * cache-read and cache-creation counters and a real per-turn cost, so all four
 * are reported rather than zeroed.
 */
const mergeGrokOverview = async (
  overview: IOverviewResponse,
  period: TPeriod,
): Promise<IOverviewResponse> => {
  const usage = await readGrokUsage(period);
  if (usage.sessions.length === 0 && usage.messageTimestamps.length === 0) return overview;

  const needsPrevious = period === '7d' || period === '30d';
  const allUsage = needsPrevious || period !== 'all' ? await readGrokUsage('all') : usage;
  const tokens = getGrokTokenBreakdown(usage);
  const { hourCounts, dayHourCounts } = getGrokHourCounts(usage);
  const today = dayjs().format('YYYY-MM-DD');
  const monthStart = dayjs().startOf('month');

  const cost = usage.sessions.reduce((sum, session) => sum + session.cost, 0);
  const todayCost = allUsage.sessions
    .filter((session) => dayjs(session.startedAt).format('YYYY-MM-DD') === today)
    .reduce((sum, session) => sum + session.cost, 0);
  const thisMonthCost = allUsage.sessions
    .filter((session) => !dayjs(session.startedAt).isBefore(monthStart))
    .reduce((sum, session) => sum + session.cost, 0);
  const todayMessages = allUsage.messageTimestamps
    .filter((timestamp) => dayjs(timestamp).format('YYYY-MM-DD') === today).length;
  const thisMonthMessages = allUsage.messageTimestamps
    .filter((timestamp) => !dayjs(timestamp).isBefore(monthStart)).length;

  const previousSessions = needsPrevious
    ? allUsage.sessions.filter((session) => isInPreviousPeriod(session.startedAt, period)).length
    : 0;
  const previousMessages = needsPrevious
    ? allUsage.messageTimestamps.filter((timestamp) => isInPreviousPeriod(timestamp, period)).length
    : 0;
  const previousCost = needsPrevious
    ? allUsage.sessions
      .filter((session) => isInPreviousPeriod(session.startedAt, period))
      .reduce((sum, session) => sum + session.cost, 0)
    : 0;

  const grokFirstSessionDate = usage.sessions.map((session) => session.startedAt.slice(0, 10)).sort()[0] ?? '';

  return {
    ...overview,
    byProvider: addProviderUsage(overview.byProvider, 'grok', {
      ...sumProviderModelTokens(tokens.modelTokens, 'grok'),
      totalCost: cost,
      sessions: usage.sessions.length,
      messages: usage.messageTimestamps.length,
    }),
    totalSessions: overview.totalSessions + usage.sessions.length,
    totalMessages: overview.totalMessages + usage.messageTimestamps.length,
    previousSessions: overview.previousSessions + previousSessions,
    previousMessages: overview.previousMessages + previousMessages,
    dailyActivity: mergeGrokDailyActivity(overview.dailyActivity, getGrokDailyActivity(usage)),
    modelTokens: mergeModelTokens(overview.modelTokens, tokens.modelTokens),
    dailyTokens: mergeDailyTokens(overview.dailyTokens, tokens.dailyTokens),
    hourlyDistribution: mergeCounts(overview.hourlyDistribution, hourCounts),
    dayHourDistribution: mergeCounts(overview.dayHourDistribution, dayHourCounts),
    todayMessages: overview.todayMessages + todayMessages,
    thisMonthMessages: overview.thisMonthMessages + thisMonthMessages,
    totalCost: overview.totalCost + cost,
    todayCost: overview.todayCost + todayCost,
    thisMonthCost: overview.thisMonthCost + thisMonthCost,
    previousCost: overview.previousCost + previousCost,
    firstSessionDate: [overview.firstSessionDate, grokFirstSessionDate].filter(Boolean).sort()[0] ?? '',
  };
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method-not-allowed' });
  }

  const period = parsePeriod(req.query.period as string | undefined);
  const cacheKey = `stats:overview:${period}`;

  const cached = getCached<IOverviewResponse>(cacheKey);
  if (cached) return res.status(200).json(cached);

  const statsCache = await getStatsCache();
  const overview = await mergeGrokOverview(
    await mergeCodexOverview(buildOverview(statsCache, period), period),
    period,
  );

  setCached(cacheKey, overview);
  return res.status(200).json(overview);
};

export default handler;
