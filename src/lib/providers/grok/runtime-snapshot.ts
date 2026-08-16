import { GROK_DB_PATH, getGrokDatabase, type IGrokDatabase } from '@/lib/providers/grok/db';
import { readGrokEntries } from '@/lib/providers/grok/transcript';
import type { IAgentRuntimeSnapshot, IAgentSessionHistoryStats } from '@/lib/providers/types';
import type { ICurrentAction } from '@/types/status';
import type { ITimelineEntry } from '@/types/timeline';

const MAX_SNIPPET_LENGTH = 200;
const STALE_MS = 90_000;
const TAIL_MESSAGES = 40;

const compact = (text: string, limit = MAX_SNIPPET_LENGTH): string => {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
};

export const emptyGrokSnapshot = (): IAgentRuntimeSnapshot => ({
  idle: false,
  stale: false,
  lastAssistantSnippet: null,
  currentAction: null,
  reset: false,
  lastEntryTs: null,
  staleMs: 0,
  interrupted: false,
});

const tailFrom = (db: IGrokDatabase, sessionId: string): ITimelineEntry[] => {
  const row = db.get<{ max_seq: number | null }>(
    'SELECT MAX(seq) AS max_seq FROM messages WHERE session_id = ?',
    sessionId,
  );
  const maxSeq = row?.max_seq ?? null;
  if (maxSeq === null) return [];
  const after = Math.max(-1, maxSeq - TAIL_MESSAGES);
  return readGrokEntries(db, sessionId, { afterMessageSeq: after });
};

/**
 * Derives the same runtime view the JSONL providers derive, from grok's tail of
 * messages. A tool call with no matching result is the action in flight; when
 * the last thing in the session is an assistant message the turn has landed.
 */
export const summarizeGrokTail = (
  entries: ITimelineEntry[],
  now: number,
): IAgentRuntimeSnapshot => {
  if (entries.length === 0) return emptyGrokSnapshot();

  const resolved = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'tool-result') resolved.add(entry.toolUseId);
  }

  let currentAction: ICurrentAction | null = null;
  let lastAssistantSnippet: string | null = null;
  let lastEntryTs: number | null = null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (lastEntryTs === null && 'timestamp' in entry && entry.timestamp) lastEntryTs = entry.timestamp;
    if (!currentAction && entry.type === 'tool-call' && !resolved.has(entry.toolUseId)) {
      currentAction = { toolName: entry.toolName, summary: entry.summary };
    }
    if (!lastAssistantSnippet && entry.type === 'assistant-message') {
      lastAssistantSnippet = compact(entry.markdown);
    }
    if (currentAction && lastAssistantSnippet) break;
  }

  const last = entries[entries.length - 1];
  const idle = !currentAction && (last.type === 'assistant-message' || last.type === 'context-compacted');
  const staleMs = lastEntryTs === null ? 0 : Math.max(0, now - lastEntryTs);

  return {
    idle,
    stale: staleMs > STALE_MS,
    lastAssistantSnippet: lastAssistantSnippet || null,
    currentAction,
    reset: last.type === 'context-compacted',
    lastEntryTs,
    staleMs,
    interrupted: false,
  };
};

/**
 * `handle` is a grok session id, not a path — grok keeps its transcript in
 * SQLite, so the provider interface's file slot carries the session key.
 */
export const readGrokRuntimeSnapshot = async (
  handle: string,
  dbPath: string = GROK_DB_PATH,
): Promise<IAgentRuntimeSnapshot> => {
  const db = getGrokDatabase(dbPath);
  if (!db) return emptyGrokSnapshot();
  return summarizeGrokTail(tailFrom(db, handle), Date.now());
};

const EMPTY_STATS: IAgentSessionHistoryStats = {
  toolUsage: {},
  touchedFiles: [],
  lastAssistantText: null,
  lastUserText: null,
  firstUserTs: null,
  lastAssistantTs: null,
  turnDurationMs: null,
};

const TOOL_USAGE_SQL = `
  SELECT tool_name, args_json
  FROM tool_calls
  WHERE session_id = ?
  ORDER BY id ASC
`;

const PATH_KEYS = ['path', 'file_path', 'filePath', 'notebook_path'] as const;

const pathFromArgs = (argsJson: string): string | null => {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    for (const key of PATH_KEYS) {
      if (typeof parsed[key] === 'string' && parsed[key]) return parsed[key] as string;
    }
  } catch {
    return null;
  }
  return null;
};

export const readGrokSessionHistoryStats = async (
  handle: string,
  dbPath: string = GROK_DB_PATH,
): Promise<IAgentSessionHistoryStats> => {
  const db = getGrokDatabase(dbPath);
  if (!db) return EMPTY_STATS;

  const toolUsage: Record<string, number> = {};
  const touchedFiles = new Set<string>();
  for (const row of db.all<{ tool_name: string; args_json: string }>(TOOL_USAGE_SQL, handle)) {
    toolUsage[row.tool_name] = (toolUsage[row.tool_name] ?? 0) + 1;
    const filePath = pathFromArgs(row.args_json);
    if (filePath) touchedFiles.add(filePath);
  }

  const entries = readGrokEntries(db, handle, { includeCompactions: false });
  let lastAssistantText: string | null = null;
  let lastUserText: string | null = null;
  let firstUserTs: number | null = null;
  let lastAssistantTs: number | null = null;

  for (const entry of entries) {
    if (entry.type === 'user-message') {
      lastUserText = entry.text;
      if (firstUserTs === null) firstUserTs = entry.timestamp;
    } else if (entry.type === 'assistant-message') {
      lastAssistantText = entry.markdown;
      lastAssistantTs = entry.timestamp;
    }
  }

  return {
    toolUsage,
    touchedFiles: [...touchedFiles],
    lastAssistantText,
    lastUserText,
    firstUserTs,
    lastAssistantTs,
    turnDurationMs: firstUserTs !== null && lastAssistantTs !== null ? lastAssistantTs - firstUserTs : null,
  };
};
