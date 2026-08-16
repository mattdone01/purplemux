import fs from 'fs/promises';
import { entrySearchText, isSearchableEntry, type IToolRecordText } from '@/lib/entry-text';
import type { IGrokDatabase } from '@/lib/providers/grok/db';
import { readGrokEntries, unwrapGrokToolOutput } from '@/lib/providers/grok/transcript';
import type { ISearchDoc } from '@/lib/search-cache';
import { parseJsonlContent } from '@/lib/session-parser';
import { codexSessionIdFromJsonlPath, parseCodexContent } from '@/lib/session-parser-codex';
import type { ITimelineEntry } from '@/types/timeline';

export type TSearchProvider = 'claude' | 'codex' | 'grok';

type TToolTextMap = Map<string, IToolRecordText>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const safeParse = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const setToolText = (map: TToolTextMap, id: string, patch: IToolRecordText): void => {
  if (!id) return;
  map.set(id, { ...map.get(id), ...patch });
};

/** A tool result is a string, a block array, or a provider envelope around one. */
const toolOutputText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (isRecord(value)) {
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return toolOutputText(value.content);
    return JSON.stringify(value);
  }
  return '';
};

const readClaudeToolText = (record: Record<string, unknown>, map: TToolTextMap): void => {
  const message = isRecord(record.message) ? record.message : null;
  const content = message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      setToolText(map, block.id, { input: JSON.stringify(block.input ?? {}) });
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      setToolText(map, block.tool_use_id, { output: toolOutputText(block.content) });
    }
  }
};

const readCodexToolText = (record: Record<string, unknown>, map: TToolTextMap): void => {
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return;
  const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
  if (!callId) return;

  switch (payload.type) {
    case 'function_call':
      setToolText(map, callId, { input: toolOutputText(payload.arguments) });
      break;
    case 'custom_tool_call':
      setToolText(map, callId, { input: toolOutputText(payload.input) });
      break;
    case 'local_shell_call':
      setToolText(map, callId, { input: JSON.stringify(payload.action ?? {}) });
      break;
    case 'function_call_output':
    case 'custom_tool_call_output':
      setToolText(map, callId, { output: toolOutputText(payload.output) });
      break;
    default:
      break;
  }
};

const TOOL_RECORD_MARKERS = [
  '"tool_use"',
  '"tool_result"',
  '"function_call',
  '"custom_tool_call',
  '"local_shell_call"',
];

/**
 * Tool input and tool output as the transcript records them.
 *
 * The parsers keep only a summary — `summarizeToolResult` collapses anything
 * multi-line to "N lines" — so a search that reads entries alone cannot find a
 * term that appears in a command's output. The record is re-read for those two
 * fields only, correlated back to the entry by `toolUseId`, which both parsers
 * carry.
 */
export const extractToolText = (content: string, provider: TSearchProvider): TToolTextMap => {
  const map: TToolTextMap = new Map();

  for (const line of content.split('\n')) {
    if (!TOOL_RECORD_MARKERS.some((marker) => line.includes(marker))) continue;
    const record = safeParse(line);
    if (!isRecord(record)) continue;
    if (provider === 'codex') readCodexToolText(record, map);
    else readClaudeToolText(record, map);
  }

  return map;
};

const toDocs = (entries: ITimelineEntry[], toolText: TToolTextMap): ISearchDoc[] => {
  const docs: ISearchDoc[] = [];

  for (const entry of entries) {
    if (!isSearchableEntry(entry)) continue;
    if (entry.seq === undefined) continue;
    const text = entrySearchText(entry, (id) => toolText.get(id));
    if (!text) continue;
    docs.push({ seq: entry.seq, entryId: entry.id, type: entry.type, timestamp: entry.timestamp, text });
  }

  return docs;
};

/** Whole-file extraction for one JSONL transcript, Claude or Codex. */
export const extractJsonlDocsFromContent = (
  content: string,
  jsonlPath: string,
  provider: TSearchProvider,
): ISearchDoc[] => {
  const entries = provider === 'codex'
    ? parseCodexContent(content, 0, codexSessionIdFromJsonlPath(jsonlPath))
    : parseJsonlContent(content, 0);

  return toDocs(entries, extractToolText(content, provider));
};

export const extractJsonlDocs = async (
  jsonlPath: string,
  provider: TSearchProvider,
): Promise<ISearchDoc[]> =>
  extractJsonlDocsFromContent(await fs.readFile(jsonlPath, 'utf-8'), jsonlPath, provider);

const GROK_TOOL_TEXT_SQL = `
  SELECT tc.tool_call_id AS tool_call_id, tc.args_json AS args_json, tr.output_json AS output_json
  FROM tool_calls tc
  LEFT JOIN tool_results tr ON tr.tool_call_row_id = tc.id
  WHERE tc.session_id = ?
`;

interface IGrokToolTextRow {
  tool_call_id: string;
  args_json: string;
  output_json: string | null;
}

/** grok keeps its transcript in SQLite, so one session is a query rather than a file. */
export const extractGrokDocs = (db: IGrokDatabase, sessionId: string): ISearchDoc[] => {
  const toolText: TToolTextMap = new Map();
  for (const row of db.all<IGrokToolTextRow>(GROK_TOOL_TEXT_SQL, sessionId)) {
    setToolText(toolText, row.tool_call_id, {
      input: row.args_json,
      output: row.output_json ? unwrapGrokToolOutput(safeParse(row.output_json)).text : undefined,
    });
  }

  return toDocs(readGrokEntries(db, sessionId, { includeCompactions: false }), toolText);
};
