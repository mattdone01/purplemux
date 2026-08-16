import fs from 'fs/promises';
import { GROK_COST_TICKS_PER_USD, parseGrokUpdateLine } from '@/lib/session-parser-grok';
import { listAllGrokSessions, readGrokSummary } from '@/lib/providers/grok/session-store';
import { isWithinPeriod } from '@/lib/stats/period-filter';
import type { TPeriod } from '@/types/stats';

export interface IGrokSessionUsage {
  sessionId: string;
  /** ISO timestamp of the session's creation. */
  startedAt: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
  messageCount: number;
}

export interface IGrokUsageSummary {
  sessions: IGrokSessionUsage[];
  /** One epoch-ms timestamp per user message, for the hour and day histograms. */
  messageTimestamps: number[];
}

const EMPTY: IGrokUsageSummary = { sessions: [], messageTimestamps: [] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

interface ITurnTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costTicks: number;
  model: string | null;
  userMessageTimestamps: number[];
}

/**
 * Token and cost truth for a grok session lives in the `turn_completed` updates
 * (`usage.{inputTokens,outputTokens,cachedReadTokens,cacheCreationTokens,
 * costUsdTicks,modelUsage}`), not in `signals.json` — that file carries counts
 * and context-window figures but no per-turn token or spend totals. Verified
 * against two recorded sessions; `costUsdTicks / 1e10` reproduced the
 * `total_cost_usd` the same run printed.
 */
export const readGrokTurnTotals = (content: string): ITurnTotals => {
  const totals: ITurnTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costTicks: 0,
    model: null,
    userMessageTimestamps: [],
  };

  content.split('\n').forEach((line, ordinal) => {
    if (!line.trim()) return;
    const update = parseGrokUpdateLine(line, ordinal);
    if (!update) return;

    if (update.kind === 'user_message_chunk') {
      // Chunks stream, so only the first of a run marks the message.
      const previous = totals.userMessageTimestamps[totals.userMessageTimestamps.length - 1];
      if (previous === undefined || update.timestamp - previous > 1000) {
        totals.userMessageTimestamps.push(update.timestamp);
      }
      return;
    }

    if (update.kind !== 'turn_completed') return;
    const usage = isRecord(update.update.usage) ? update.update.usage : null;
    if (!usage) return;

    totals.inputTokens += num(usage.inputTokens);
    totals.outputTokens += num(usage.outputTokens);
    totals.cacheReadTokens += num(usage.cachedReadTokens);
    totals.cacheCreationTokens += num(usage.cacheCreationTokens);
    totals.costTicks += num(usage.costUsdTicks);

    const modelUsage = isRecord(usage.modelUsage) ? usage.modelUsage : {};
    const model = Object.keys(modelUsage)[0];
    if (model) totals.model = model;
  });

  return totals;
};

/**
 * Usage across every grok home — the unscoped `~/.grok` and each workspace's
 * own. Each session lives in exactly one home, so walking all of them cannot
 * double-count.
 */
export const readGrokUsage = async (period: TPeriod): Promise<IGrokUsageSummary> => {
  const refs = await listAllGrokSessions();
  if (refs.length === 0) return EMPTY;

  const sessions: IGrokSessionUsage[] = [];
  const messageTimestamps: number[] = [];

  for (const ref of refs) {
    const summary = await readGrokSummary(ref.sessionDir);
    const startedAt = summary?.createdAt ?? new Date(ref.lastActivityMs).toISOString();
    if (!isWithinPeriod(startedAt, period)) continue;

    const content = await fs.readFile(ref.jsonlPath, 'utf-8').catch(() => '');
    const totals = readGrokTurnTotals(content);

    sessions.push({
      sessionId: ref.sessionId,
      startedAt: new Date(startedAt).toISOString(),
      model: totals.model ?? summary?.model ?? null,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      cost: totals.costTicks / GROK_COST_TICKS_PER_USD,
      messageCount: totals.userMessageTimestamps.length,
    });
    messageTimestamps.push(...totals.userMessageTimestamps);
  }

  return { sessions, messageTimestamps };
};
