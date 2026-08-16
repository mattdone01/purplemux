import fs from 'fs/promises';
import { entrySearchText, isSearchableEntry, type IToolRecordText } from '@/lib/entry-text';
import type { ISearchDoc } from '@/lib/search-cache';
import { parseJsonlContent } from '@/lib/session-parser';
import { codexSessionIdFromJsonlPath, parseCodexContent } from '@/lib/session-parser-codex';
import { parseGrokContent, parseGrokUpdateLine } from '@/lib/session-parser-grok';
import { grokSessionIdFromJsonlPath } from '@/lib/providers/grok/paths';
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
  '"tool_call"',
  '"tool_call_update"',
];

/**
 * grok carries a tool's arguments on the ACP `tool_call` and its output on the
 * `tool_call_update` that settles it, both keyed by `toolCallId`.
 */
const readGrokToolText = (record: Record<string, unknown>, map: TToolTextMap, ordinal: number): void => {
  const update = parseGrokUpdateLine(JSON.stringify(record), ordinal);
  if (!update) return;
  const callId = typeof update.update.toolCallId === 'string' ? update.update.toolCallId : '';
  if (!callId) return;

  if (update.kind === 'tool_call') {
    setToolText(map, callId, { input: JSON.stringify(update.update.rawInput ?? {}) });
  } else if (update.kind === 'tool_call_update' && update.update.rawOutput !== undefined) {
    setToolText(map, callId, { output: toolOutputText(update.update.rawOutput) });
  }
};

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

  content.split('\n').forEach((line, ordinal) => {
    if (!TOOL_RECORD_MARKERS.some((marker) => line.includes(marker))) return;
    const record = safeParse(line);
    if (!isRecord(record)) return;
    if (provider === 'codex') readCodexToolText(record, map);
    else if (provider === 'grok') readGrokToolText(record, map, ordinal);
    else readClaudeToolText(record, map);
  });

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

/** Whole-file extraction for one JSONL transcript — Claude, Codex or grok. */
export const extractJsonlDocsFromContent = (
  content: string,
  jsonlPath: string,
  provider: TSearchProvider,
): ISearchDoc[] => {
  let entries: ITimelineEntry[];
  if (provider === 'codex') {
    entries = parseCodexContent(content, 0, codexSessionIdFromJsonlPath(jsonlPath));
  } else if (provider === 'grok') {
    entries = parseGrokContent(content, grokSessionIdFromJsonlPath(jsonlPath) ?? '');
  } else {
    entries = parseJsonlContent(content, 0);
  }

  return toDocs(entries, extractToolText(content, provider));
};

export const extractJsonlDocs = async (
  jsonlPath: string,
  provider: TSearchProvider,
): Promise<ISearchDoc[]> =>
  extractJsonlDocsFromContent(await fs.readFile(jsonlPath, 'utf-8'), jsonlPath, provider);
