import { GROK_DB_PATH, getGrokDatabase } from '@/lib/providers/grok/db';
import { isWithinPeriod } from '@/lib/stats/period-filter';
import type { TPeriod } from '@/types/stats';

export interface IGrokSessionUsage {
  sessionId: string;
  /** ISO timestamp of the session's first message. */
  startedAt: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  messageCount: number;
}

export interface IGrokUsageSummary {
  sessions: IGrokSessionUsage[];
  /** One epoch-ms timestamp per user message, for the hour and day histograms. */
  messageTimestamps: number[];
}

interface ISessionRow {
  id: string;
  model: string | null;
  created_at: string;
}

interface IUsageRow {
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
}

interface IMessageRow {
  session_id: string;
  created_at: string;
}

const SESSIONS_SQL = 'SELECT id, model, created_at FROM sessions';
const USAGE_SQL = 'SELECT session_id, model, input_tokens, output_tokens, cost_micros FROM usage_events';
const USER_MESSAGES_SQL = "SELECT session_id, created_at FROM messages WHERE role = 'user'";

const EMPTY: IGrokUsageSummary = { sessions: [], messageTimestamps: [] };

/**
 * grok's `usage_events` is the whole usage story: tokens and `cost_micros` per
 * model, per message. There are no cache-read or cache-creation counters and no
 * rate-limit windows, so those stay zero rather than being invented.
 */
export const readGrokUsage = (
  period: TPeriod,
  dbPath: string = GROK_DB_PATH,
): IGrokUsageSummary => {
  const db = getGrokDatabase(dbPath);
  if (!db) return EMPTY;

  const sessions = db.all<ISessionRow>(SESSIONS_SQL);
  if (sessions.length === 0) return EMPTY;

  // Micros are summed and converted once: dividing each row loses precision the
  // session total then carries.
  const usageBySession = new Map<string, { input: number; output: number; costMicros: number; model: string | null }>();
  for (const row of db.all<IUsageRow>(USAGE_SQL)) {
    const acc = usageBySession.get(row.session_id) ?? { input: 0, output: 0, costMicros: 0, model: null };
    acc.input += row.input_tokens;
    acc.output += row.output_tokens;
    acc.costMicros += row.cost_micros;
    if (row.model) acc.model = row.model;
    usageBySession.set(row.session_id, acc);
  }

  const messageCounts = new Map<string, number>();
  const messageTimestamps: number[] = [];
  for (const row of db.all<IMessageRow>(USER_MESSAGES_SQL)) {
    if (!isWithinPeriod(row.created_at, period)) continue;
    messageCounts.set(row.session_id, (messageCounts.get(row.session_id) ?? 0) + 1);
    const ts = Date.parse(row.created_at);
    if (!Number.isNaN(ts)) messageTimestamps.push(ts);
  }

  const result: IGrokSessionUsage[] = [];
  for (const session of sessions) {
    if (!isWithinPeriod(session.created_at, period)) continue;
    const usage = usageBySession.get(session.id);
    result.push({
      sessionId: session.id,
      startedAt: new Date(session.created_at).toISOString(),
      model: usage?.model ?? session.model ?? null,
      inputTokens: usage?.input ?? 0,
      outputTokens: usage?.output ?? 0,
      cost: usage ? usage.costMicros / 1_000_000 : 0,
      messageCount: messageCounts.get(session.id) ?? 0,
    });
  }

  return { sessions: result, messageTimestamps };
};
