import { summarizeToolCall, summarizeToolResult } from '@/lib/session-parser';
import type { IGrokDatabase } from '@/lib/providers/grok/db';
import type {
  ITimelineAssistantMessage,
  ITimelineEntry,
  ITimelineToolCall,
  ITimelineToolResult,
} from '@/types/timeline';

export const GROK_PROVIDER_ID = 'grok';

/**
 * grok numbers messages densely (0, 1, 2 …) while story 02 requires a strictly
 * increasing `seq` across entries. One message can yield several entries
 * (reasoning + text + tool calls), so the message seq is scaled and the
 * entry's ordinal within the message occupies the low digits.
 */
export const GROK_SEQ_STRIDE = 1000;

export interface IGrokMessageRow {
  seq: number;
  role: string;
  message_json: string;
  created_at: string;
}

export interface IGrokToolResultRow {
  tool_call_id: string;
  output_json: string;
  success: number;
}

export interface IGrokCompactionRow {
  first_kept_seq: number;
  summary: string;
  tokens_before: number;
  created_at: string;
}

export interface IGrokUsageRow {
  message_seq: number | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_micros: number;
}

export interface IGrokSessionRow {
  id: string;
  workspace_id: string;
  title: string | null;
  recap_text: string | null;
  model: string;
  mode: string;
  cwd_at_start: string;
  cwd_last: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export const grokEntrySeq = (messageSeq: number, ordinal: number): number =>
  messageSeq * GROK_SEQ_STRIDE + ordinal;

export const grokEntryId = (
  sessionId: string,
  seq: number,
  ordinal: number,
  total: number,
): string =>
  total === 1 && ordinal === 0
    ? `${GROK_PROVIDER_ID}:${sessionId}:${seq}`
    : `${GROK_PROVIDER_ID}:${sessionId}:${seq}#${ordinal}`;

const toTimestamp = (createdAt: string | null | undefined): number => {
  const parsed = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const reasoningText = (part: Record<string, unknown>): string => {
  if (part.type !== 'reasoning') return '';
  return asString(part.text) || asString(part.reasoning);
};

const renderUserText = (content: unknown): string => {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!isRecord(part)) return '';
      if (part.type === 'text') return asString(part.text);
      if (part.type === 'image') return '[Image]';
      if (part.type === 'file') return part.filename ? `[File: ${asString(part.filename)}]` : '[File]';
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
};

const toolInput = (part: Record<string, unknown>): Record<string, unknown> =>
  isRecord(part.input) ? part.input : {};

/**
 * grok stores a tool result as the AI-SDK output envelope. `extractToolResultFromOutput`
 * in grok's own store unwraps `{type:'json'|'text'|'error-text', value}` and the
 * `{success, output, error}` tool shape; this mirrors it for display.
 */
export const unwrapGrokToolOutput = (output: unknown): { text: string; isError: boolean } => {
  if (!isRecord(output)) return { text: typeof output === 'string' ? output : '', isError: false };

  if ('success' in output) {
    const success = Boolean(output.success);
    return { text: asString(success ? output.output : output.error), isError: !success };
  }

  const kind = asString(output.type);
  if (kind === 'json' && 'value' in output) return unwrapGrokToolOutput(output.value);
  if (kind === 'error-text' || kind === 'error-json') {
    return { text: typeof output.value === 'string' ? output.value : JSON.stringify(output.value ?? ''), isError: true };
  }
  if (kind === 'text' && 'value' in output) return { text: asString(output.value), isError: false };

  return { text: JSON.stringify(output), isError: false };
};

interface IMapMessageOptions {
  usage?: IGrokUsageRow | null;
  storedResults?: Map<string, IGrokToolResultRow>;
}

const mapAssistantContent = (
  content: unknown,
  timestamp: number,
): ITimelineEntry[] => {
  if (typeof content === 'string') {
    const markdown = content.trim();
    return markdown ? [{ type: 'assistant-message', id: '', timestamp, markdown }] : [];
  }
  if (!Array.isArray(content)) return [];

  const entries: ITimelineEntry[] = [];
  const textParts: string[] = [];
  const toolCalls: ITimelineToolCall[] = [];

  for (const part of content) {
    if (!isRecord(part)) continue;
    const reasoning = reasoningText(part);
    if (reasoning) {
      entries.push({ type: 'thinking', id: '', timestamp, thinking: reasoning });
      continue;
    }
    if (part.type === 'text') {
      textParts.push(asString(part.text));
      continue;
    }
    if (part.type === 'tool-call') {
      const toolName = asString(part.toolName);
      toolCalls.push({
        type: 'tool-call',
        id: '',
        timestamp,
        toolUseId: asString(part.toolCallId),
        toolName,
        summary: summarizeToolCall(toolName, toolInput(part)),
        status: 'pending',
      });
    }
  }

  const markdown = textParts.join('').trim();
  if (markdown) {
    entries.push({ type: 'assistant-message', id: '', timestamp, markdown });
  }
  entries.push(...toolCalls);
  return entries;
};

const mapToolContent = (
  content: unknown,
  timestamp: number,
  storedResults: Map<string, IGrokToolResultRow> | undefined,
): ITimelineEntry[] => {
  if (!Array.isArray(content)) return [];
  const entries: ITimelineToolResult[] = [];

  for (const part of content) {
    if (!isRecord(part) || part.type !== 'tool-result') continue;
    const toolUseId = asString(part.toolCallId);
    const stored = storedResults?.get(toolUseId);
    const raw = stored ? safeParse(stored.output_json) : part.output;
    const { text, isError } = unwrapGrokToolOutput(raw);
    const failed = stored ? stored.success === 0 : isError;
    entries.push({
      type: 'tool-result',
      id: '',
      timestamp,
      toolUseId,
      isError: failed,
      summary: summarizeToolResult(text, failed),
    });
  }

  return entries;
};

const safeParse = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const attachUsage = (entries: ITimelineEntry[], usage: IGrokUsageRow | null | undefined): void => {
  if (!usage) return;
  const assistant = entries.find((entry): entry is ITimelineAssistantMessage => entry.type === 'assistant-message');
  if (!assistant) return;
  assistant.model = usage.model;
  assistant.usage = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
};

/** Maps one `messages` row to the entries it produces, stamped with grok-native identity. */
export const mapGrokMessageRow = (
  sessionId: string,
  row: IGrokMessageRow,
  options: IMapMessageOptions = {},
): ITimelineEntry[] => {
  const timestamp = toTimestamp(row.created_at);
  const parsed = safeParse(row.message_json);

  let entries: ITimelineEntry[];
  if (!isRecord(parsed)) {
    entries = [{
      type: 'error-notice',
      id: '',
      timestamp,
      severity: 'error',
      message: `Unreadable grok message at seq ${row.seq}`,
    }];
  } else if (row.role === 'user') {
    const text = renderUserText(parsed.content);
    entries = text ? [{ type: 'user-message', id: '', timestamp, text }] : [];
  } else if (row.role === 'assistant') {
    entries = mapAssistantContent(parsed.content, timestamp);
    attachUsage(entries, options.usage);
  } else if (row.role === 'tool') {
    entries = mapToolContent(parsed.content, timestamp, options.storedResults);
  } else if (row.role === 'system') {
    const markdown = asString(parsed.content).trim();
    entries = markdown ? [{ type: 'assistant-message', id: '', timestamp, markdown }] : [];
  } else {
    entries = [];
  }

  entries.forEach((entry, ordinal) => {
    entry.seq = grokEntrySeq(row.seq, ordinal);
    entry.id = grokEntryId(sessionId, entry.seq, ordinal, entries.length);
  });
  return entries;
};

/**
 * A compaction has no message row, so it lands immediately before the first
 * message it kept. Several compactions sharing a `first_kept_seq` are ordinal-
 * numbered so their ids stay distinct.
 */
export const mapGrokCompactionRows = (
  sessionId: string,
  rows: IGrokCompactionRow[],
): ITimelineEntry[] => {
  const ordinalBySeq = new Map<number, number>();
  return rows.map((row) => {
    const anchor = Math.max(0, grokEntrySeq(row.first_kept_seq, 0) - 1);
    const ordinal = ordinalBySeq.get(anchor) ?? 0;
    ordinalBySeq.set(anchor, ordinal + 1);
    return {
      type: 'context-compacted' as const,
      id: grokEntryId(sessionId, anchor, ordinal, ordinal === 0 ? 1 : 2),
      seq: anchor,
      timestamp: toTimestamp(row.created_at),
      beforeTokens: row.tokens_before,
    };
  });
};

const MESSAGE_SQL = `
  SELECT seq, role, message_json, created_at
  FROM messages
  WHERE session_id = ? AND seq > ?
  ORDER BY seq ASC
`;

const TOOL_RESULT_SQL = `
  SELECT tc.tool_call_id AS tool_call_id, tr.output_json AS output_json, tr.success AS success
  FROM tool_results tr
  JOIN tool_calls tc ON tc.id = tr.tool_call_row_id
  WHERE tc.session_id = ?
  ORDER BY tr.id ASC
`;

const COMPACTION_SQL = `
  SELECT first_kept_seq, summary, tokens_before, created_at
  FROM compactions
  WHERE session_id = ?
  ORDER BY id ASC
`;

const USAGE_SQL = `
  SELECT message_seq, model, input_tokens, output_tokens, total_tokens, cost_micros
  FROM usage_events
  WHERE session_id = ?
  ORDER BY id ASC
`;

export interface IReadGrokEntriesOptions {
  /** Exclusive lower bound on `messages.seq`; -1 reads the whole session. */
  afterMessageSeq?: number;
  includeCompactions?: boolean;
}

/** Reads a whole grok session (or the tail after `afterMessageSeq`) as timeline entries. */
export const readGrokEntries = (
  db: IGrokDatabase,
  sessionId: string,
  options: IReadGrokEntriesOptions = {},
): ITimelineEntry[] => {
  const after = options.afterMessageSeq ?? -1;
  const rows = db.all<IGrokMessageRow>(MESSAGE_SQL, sessionId, after);
  if (rows.length === 0 && after >= 0) return [];

  const storedResults = new Map<string, IGrokToolResultRow>();
  for (const row of db.all<IGrokToolResultRow>(TOOL_RESULT_SQL, sessionId)) {
    storedResults.set(row.tool_call_id, row);
  }

  const usageBySeq = new Map<number, IGrokUsageRow>();
  for (const row of db.all<IGrokUsageRow>(USAGE_SQL, sessionId)) {
    if (row.message_seq !== null) usageBySeq.set(row.message_seq, row);
  }

  const entries: ITimelineEntry[] = [];
  for (const row of rows) {
    entries.push(...mapGrokMessageRow(sessionId, row, {
      storedResults,
      usage: usageBySeq.get(row.seq) ?? null,
    }));
  }

  if (options.includeCompactions !== false) {
    const compactions = db.all<IGrokCompactionRow>(COMPACTION_SQL, sessionId)
      .filter((row) => row.first_kept_seq > after);
    entries.push(...mapGrokCompactionRows(sessionId, compactions));
  }

  entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return entries;
};

export const readGrokSession = (db: IGrokDatabase, sessionId: string): IGrokSessionRow | null =>
  db.get<IGrokSessionRow>(
    `SELECT id, workspace_id, title, recap_text, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at
     FROM sessions WHERE id = ?`,
    sessionId,
  );

export const readGrokMaxMessageSeq = (db: IGrokDatabase, sessionId: string): number => {
  const row = db.get<{ max_seq: number | null }>(
    'SELECT MAX(seq) AS max_seq FROM messages WHERE session_id = ?',
    sessionId,
  );
  return row?.max_seq ?? -1;
};
