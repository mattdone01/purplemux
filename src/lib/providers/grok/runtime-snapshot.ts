import fs from 'fs/promises';
import path from 'path';
import { parseGrokContent } from '@/lib/session-parser-grok';
import { grokSessionIdFromJsonlPath } from '@/lib/providers/grok/paths';
import type { IAgentRuntimeSnapshot, IAgentSessionHistoryStats } from '@/lib/providers/types';
import type { ICurrentAction } from '@/types/status';
import type { ITimelineEntry } from '@/types/timeline';

const MAX_SNIPPET_LENGTH = 200;
const STALE_MS = 90_000;
const MAX_CACHE = 256;

interface ICacheEntry {
  mtimeMs: number;
  entries: ITimelineEntry[];
}

const g = globalThis as unknown as { __ptGrokEntryCache?: Map<string, ICacheEntry> };
if (!g.__ptGrokEntryCache) g.__ptGrokEntryCache = new Map();
const cache = g.__ptGrokEntryCache;

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

/**
 * grok's `seq` is an update ordinal, so a tail window cannot be numbered without
 * the lines before it and the whole transcript is parsed. The result is cached
 * on mtime, which keeps a poll on an idle session free.
 */
const readEntries = async (jsonlPath: string): Promise<ITimelineEntry[]> => {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(jsonlPath)).mtimeMs;
  } catch {
    return [];
  }

  const cached = cache.get(jsonlPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.entries;

  let content: string;
  try {
    content = await fs.readFile(jsonlPath, 'utf-8');
  } catch {
    return [];
  }

  const entries = parseGrokContent(content, grokSessionIdFromJsonlPath(jsonlPath) ?? '');
  cache.set(jsonlPath, { mtimeMs, entries });
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return entries;
};

/**
 * The same runtime view the other providers derive, from grok's ACP updates: a
 * tool call with no terminal update is the action in flight, and a turn that
 * ended on an assistant message has landed.
 */
export const summarizeGrokEntries = (
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

export const readGrokRuntimeSnapshot = async (jsonlPath: string): Promise<IAgentRuntimeSnapshot> =>
  summarizeGrokEntries(await readEntries(jsonlPath), Date.now());

const EMPTY_STATS: IAgentSessionHistoryStats = {
  toolUsage: {},
  touchedFiles: [],
  lastAssistantText: null,
  lastUserText: null,
  firstUserTs: null,
  lastAssistantTs: null,
  turnDurationMs: null,
};

const PATH_IN_SUMMARY = /(?:^|\s)((?:\/|\.{0,2}\/)?[\w.@/-]+\.[\w]+)(?=\s|$|\))/;

export const readGrokSessionHistoryStats = async (
  jsonlPath: string,
): Promise<IAgentSessionHistoryStats> => {
  const entries = await readEntries(jsonlPath);
  if (entries.length === 0) return EMPTY_STATS;

  const toolUsage: Record<string, number> = {};
  const touchedFiles = new Set<string>();
  let lastAssistantText: string | null = null;
  let lastUserText: string | null = null;
  let firstUserTs: number | null = null;
  let lastAssistantTs: number | null = null;

  for (const entry of entries) {
    if (entry.type === 'tool-call') {
      toolUsage[entry.toolName] = (toolUsage[entry.toolName] ?? 0) + 1;
      const filePath = entry.filePath ?? entry.summary.match(PATH_IN_SUMMARY)?.[1];
      if (filePath) touchedFiles.add(path.normalize(filePath));
    } else if (entry.type === 'user-message') {
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
