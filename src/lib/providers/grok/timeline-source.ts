import fs from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { GROK_DB_PATH, GROK_HOME, getGrokDatabase } from '@/lib/providers/grok/db';
import {
  GROK_PROVIDER_ID,
  readGrokEntries,
  readGrokMaxMessageSeq,
  readGrokSession,
  type IGrokUsageRow,
} from '@/lib/providers/grok/transcript';
import type { IInitMeta, ISessionStats, ITimelineEntry } from '@/types/timeline';

const log = createLogger('grok-timeline');

const WATCH_DEBOUNCE_MS = 250;
/** grok writes `grok.db`, `grok.db-wal` and `grok.db-shm`; a WAL commit touches only the tail files. */
const WATCHED_PREFIX = 'grok.db';

export interface IGrokTimelineInit {
  entries: ITimelineEntry[];
  /** Highest `messages.seq` reflected in `entries`; -1 when the session is empty. */
  lastMessageSeq: number;
  totalEntries: number;
  hasMore: boolean;
  summary: string | null;
  meta: IInitMeta;
  sessionStats: ISessionStats | null;
}

const EMPTY_META: IInitMeta = {
  createdAt: null,
  updatedAt: null,
  lastTimestamp: 0,
  fileSize: 0,
  userCount: 0,
  assistantCount: 0,
};

const buildMeta = (entries: ITimelineEntry[], createdAt: string | null, title: string | null): IInitMeta => {
  let updatedAt: string | null = null;
  let lastTimestamp = 0;
  let userCount = 0;
  let assistantCount = 0;

  for (const entry of entries) {
    if ('timestamp' in entry && entry.timestamp) {
      lastTimestamp = Math.max(lastTimestamp, entry.timestamp);
      updatedAt = new Date(entry.timestamp).toISOString();
    }
    if (entry.type === 'user-message') userCount += 1;
    else if (entry.type === 'assistant-message') assistantCount += 1;
  }

  return {
    createdAt,
    updatedAt,
    lastTimestamp,
    fileSize: 0,
    userCount,
    assistantCount,
    ...(title ? { customTitle: title } : {}),
  };
};

const USAGE_TOTALS_SQL = `
  SELECT message_seq, model, input_tokens, output_tokens, total_tokens, cost_micros
  FROM usage_events
  WHERE session_id = ?
  ORDER BY id ASC
`;

export const buildGrokSessionStats = (
  sessionId: string,
  rows: IGrokUsageRow[],
  model: string | null,
): ISessionStats => {
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;
  let lastModel = model;

  for (const row of rows) {
    inputTokens += row.input_tokens;
    outputTokens += row.output_tokens;
    costMicros += row.cost_micros;
    if (row.model) lastModel = row.model;
  }

  return {
    sessionId,
    inputTokens,
    outputTokens,
    cost: rows.length > 0 ? costMicros / 1_000_000 : null,
    model: lastModel,
  };
};

/**
 * Reads a grok session as a timeline `init` payload. Unlike the JSONL sources
 * there is no byte offset to page from — grok's `messages.seq` is the cursor,
 * so the tail is taken by row count.
 */
export const readGrokTimelineInit = (
  sessionId: string,
  maxEntries: number,
  dbPath: string = GROK_DB_PATH,
): IGrokTimelineInit => {
  const db = getGrokDatabase(dbPath);
  if (!db) {
    return {
      entries: [],
      lastMessageSeq: -1,
      totalEntries: 0,
      hasMore: false,
      summary: null,
      meta: EMPTY_META,
      sessionStats: null,
    };
  }

  const all = readGrokEntries(db, sessionId);
  const hasMore = all.length > maxEntries;
  const entries = hasMore ? all.slice(-maxEntries) : all;
  const session = readGrokSession(db, sessionId);
  const usage = db.all<IGrokUsageRow>(USAGE_TOTALS_SQL, sessionId);

  return {
    entries,
    lastMessageSeq: readGrokMaxMessageSeq(db, sessionId),
    totalEntries: entries.length,
    hasMore,
    summary: session?.title ?? session?.recap_text ?? null,
    meta: buildMeta(all, session?.created_at ?? null, session?.title ?? null),
    sessionStats: buildGrokSessionStats(sessionId, usage, session?.model ?? null),
  };
};

export interface IGrokTimelineTail {
  entries: ITimelineEntry[];
  lastMessageSeq: number;
}

/** Entries recorded after `afterMessageSeq`, for a `timeline:append`. */
export const readGrokTimelineTail = (
  sessionId: string,
  afterMessageSeq: number,
  dbPath: string = GROK_DB_PATH,
): IGrokTimelineTail => {
  const db = getGrokDatabase(dbPath);
  if (!db) return { entries: [], lastMessageSeq: afterMessageSeq };
  return {
    entries: readGrokEntries(db, sessionId, { afterMessageSeq }),
    lastMessageSeq: readGrokMaxMessageSeq(db, sessionId),
  };
};

export interface IGrokDbWatcher {
  stop: () => void;
}

/**
 * Watches grok's store for commits. The directory is watched rather than the
 * file: a WAL commit lands in `grok.db-wal`, and SQLite replaces the inode on
 * checkpoint, which an `fs.watch` bound to the file would stop following.
 */
export const watchGrokDb = (
  onChange: () => void,
  dbPath: string = GROK_DB_PATH,
): IGrokDbWatcher => {
  const dir = path.dirname(dbPath);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;

  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, WATCH_DEBOUNCE_MS);
  };

  try {
    watcher = fs.watch(dir, (_event, filename) => {
      if (filename && !String(filename).startsWith(WATCHED_PREFIX)) return;
      fire();
    });
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err, dir }, 'grok store watch failed');
  }

  return {
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        watcher?.close();
      } catch {
        // already closed
      }
    },
  };
};

export const GROK_STORE_DIR = GROK_HOME;
export { GROK_PROVIDER_ID };
