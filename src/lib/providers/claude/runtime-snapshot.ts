import fs from 'fs/promises';
import { INTERRUPT_PREFIX, summarizeToolCall } from '@/lib/session-parser';
import type { IAgentRuntimeSnapshot } from '@/lib/providers/types';
import type { ICurrentAction } from '@/types/status';
import type { TToolName } from '@/types/timeline';

const JSONL_TAIL_SIZE = 8192;
const JSONL_EXTENDED_TAIL_SIZE = 131_072;
const STALE_MS_INTERRUPTED = 20_000;
const STALE_MS_AWAITING_API = 90_000;
const MAX_JSONL_CACHE = 256;
const MAX_SNIPPET_LENGTH = 200;

interface IJsonlIdleCache {
  mtimeMs: number;
  idle: boolean;
  stale: boolean;
  needsStaleRecheck: boolean;
  staleMs: number;
  lastAssistantSnippet: string | null;
  currentAction: ICurrentAction | null;
  reset: boolean;
  lastEntryTs: number | null;
  interrupted: boolean;
}

interface IAssistantExtract {
  lastAssistantSnippet: string | null;
  currentAction: ICurrentAction | null;
  reset: boolean;
}

interface IScanResult {
  matched: boolean;
  idle: boolean;
  stale: boolean;
  needsStaleRecheck: boolean;
  staleMs: number;
  lastEntryTs: number | null;
  interrupted: boolean;
}

const g = globalThis as unknown as { __ptClaudeRuntimeSnapshotCache?: Map<string, IJsonlIdleCache> };
if (!g.__ptClaudeRuntimeSnapshotCache) g.__ptClaudeRuntimeSnapshotCache = new Map();
const jsonlIdleCache = g.__ptClaudeRuntimeSnapshotCache;

/**
 * Background work the Claude harness starts for the agent and later reports
 * back: `Bash(run_in_background)` prints "Command running in background with
 * ID: <id>", `Agent` prints "agentId: <id>", and each finishes with a
 * `<task-notification>` carrying `<task-id><id></task-id>`. A turn that ends
 * with any of them open is a wait, not a finish. Tool results and
 * notifications both arrive as `user`-typed entries.
 */
const BACKGROUND_START_PATTERNS = [
  /Command running in background with ID:\s*([A-Za-z0-9_-]+)/g,
  /agentId:\s*([A-Za-z0-9_-]+)/g,
];
const TASK_NOTIFICATION_PATTERN = /<task-id>\s*([A-Za-z0-9_-]+)\s*<\/task-id>/g;

const textBlocksOf = (entry: { message?: { content?: unknown } }): string[] => {
  const c = entry.message?.content;
  if (typeof c === 'string') return [c];
  if (!Array.isArray(c)) return [];
  const out: string[] = [];
  for (const block of c as Array<{ type?: string; text?: string; content?: unknown }>) {
    if (typeof block.text === 'string') out.push(block.text);
    if (typeof block.content === 'string') out.push(block.content);
    if (Array.isArray(block.content)) {
      for (const inner of block.content as Array<{ text?: string }>) {
        if (typeof inner.text === 'string') out.push(inner.text);
      }
    }
  }
  return out;
};

export const countOpenBackgroundTasks = (lines: string[]): number => {
  const started = new Set<string>();
  const finished = new Set<string>();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.isSidechain || entry.type !== 'user') continue;
      for (const text of textBlocksOf(entry)) {
        for (const pattern of BACKGROUND_START_PATTERNS) {
          pattern.lastIndex = 0;
          for (const m of text.matchAll(pattern)) started.add(m[1]);
        }
        TASK_NOTIFICATION_PATTERN.lastIndex = 0;
        for (const m of text.matchAll(TASK_NOTIFICATION_PATTERN)) finished.add(m[1]);
      }
    } catch { continue; }
  }
  let open = 0;
  for (const id of started) if (!finished.has(id)) open += 1;
  return open;
};

const emptySnapshot = (): IAgentRuntimeSnapshot => ({
  idle: false,
  stale: false,
  lastAssistantSnippet: null,
  currentAction: null,
  reset: false,
  lastEntryTs: null,
  staleMs: 0,
  interrupted: false,
});

const toCurrentAction = (block: { name?: string; input?: Record<string, unknown> }): ICurrentAction => {
  const toolName = (block.name ?? 'Tool') as TToolName;
  const input = (block.input ?? {}) as Record<string, unknown>;
  return { toolName, summary: summarizeToolCall(toolName, input) };
};

const extractAssistantInfo = (lines: string[]): IAssistantExtract => {
  let userMessageSeen = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.isSidechain) continue;

      if (entry.type === 'user') {
        const c = entry.message?.content;
        const isToolResult = Array.isArray(c) && c.some((b: unknown) => (b as { type?: string }).type === 'tool_result');
        if (!isToolResult) userMessageSeen = true;
        continue;
      }

      if (entry.type !== 'assistant' || !entry.message?.content) continue;

      if (userMessageSeen) return { lastAssistantSnippet: null, currentAction: null, reset: true };

      const content = entry.message.content;
      if (!Array.isArray(content)) continue;

      let lastAssistantSnippet: string | null = null;
      let currentAction: ICurrentAction | null = null;

      for (let j = content.length - 1; j >= 0; j--) {
        const block = content[j];
        if (block.type === 'tool_use') {
          currentAction = toCurrentAction(block);
          break;
        }
        if (block.type === 'text' && block.text?.trim()) {
          const text = block.text.trim();
          currentAction = {
            toolName: null,
            summary: text.length > MAX_SNIPPET_LENGTH ? text.slice(0, MAX_SNIPPET_LENGTH) + '…' : text,
          };
          break;
        }
      }

      for (let j = content.length - 1; j >= 0; j--) {
        if (content[j].type === 'text' && content[j].text?.trim()) {
          const text = content[j].text.trim();
          lastAssistantSnippet = text.length > MAX_SNIPPET_LENGTH
            ? text.slice(0, MAX_SNIPPET_LENGTH) + '…'
            : text;
          break;
        }
      }

      return { lastAssistantSnippet, currentAction, reset: false };
    } catch { continue; }
  }
  return { lastAssistantSnippet: null, currentAction: null, reset: false };
};

const scanLines = (lines: string[], elapsed: number): IScanResult => {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);

      if (entry.isSidechain) continue;

      const entryTs: number | null = entry.timestamp ? new Date(entry.timestamp).getTime() : null;

      if (entry.type === 'system' && (entry.subtype === 'stop_hook_summary' || entry.subtype === 'turn_duration')) {
        return { matched: true, idle: true, stale: false, needsStaleRecheck: false, staleMs: 0, lastEntryTs: entryTs, interrupted: false };
      }

      if (entry.type === 'assistant') {
        const stopReason = entry.message?.stop_reason;
        if (!stopReason) {
          const idle = elapsed > STALE_MS_INTERRUPTED;
          return { matched: true, idle, stale: true, needsStaleRecheck: !idle, staleMs: STALE_MS_INTERRUPTED, lastEntryTs: entryTs, interrupted: false };
        }
        return { matched: true, idle: stopReason !== 'tool_use', stale: false, needsStaleRecheck: false, staleMs: 0, lastEntryTs: entryTs, interrupted: false };
      }

      if (entry.type === 'user') {
        const content = entry.message?.content;
        if (Array.isArray(content) && content.length === 1 && typeof content[0]?.text === 'string' && content[0].text.startsWith(INTERRUPT_PREFIX)) {
          return { matched: true, idle: true, stale: false, needsStaleRecheck: false, staleMs: 0, lastEntryTs: entryTs, interrupted: true };
        }
        const idle = elapsed > STALE_MS_AWAITING_API;
        return { matched: true, idle, stale: true, needsStaleRecheck: !idle, staleMs: STALE_MS_AWAITING_API, lastEntryTs: entryTs, interrupted: false };
      }
    } catch {
      continue;
    }
  }

  return { matched: false, idle: elapsed > STALE_MS_AWAITING_API, stale: true, needsStaleRecheck: elapsed <= STALE_MS_AWAITING_API, staleMs: STALE_MS_AWAITING_API, lastEntryTs: null, interrupted: false };
};

export const readClaudeRuntimeSnapshot = async (
  jsonlPath: string,
  options: { force?: boolean } = {},
): Promise<IAgentRuntimeSnapshot> => {
  try {
    const stat = await fs.stat(jsonlPath);
    if (stat.size === 0) return { ...emptySnapshot(), idle: true };

    const cached = jsonlIdleCache.get(jsonlPath);
    if (!options.force && cached && cached.mtimeMs === stat.mtimeMs) {
      jsonlIdleCache.delete(jsonlPath);
      jsonlIdleCache.set(jsonlPath, cached);
      if (cached.idle) return { idle: true, stale: cached.stale, lastAssistantSnippet: cached.lastAssistantSnippet, currentAction: cached.currentAction, reset: cached.reset, lastEntryTs: cached.lastEntryTs, staleMs: cached.staleMs, interrupted: cached.interrupted };
      if (cached.needsStaleRecheck) {
        const idle = Date.now() - stat.mtimeMs > cached.staleMs;
        return { idle, stale: true, lastAssistantSnippet: cached.lastAssistantSnippet, currentAction: cached.currentAction, reset: cached.reset, lastEntryTs: cached.lastEntryTs, staleMs: cached.staleMs, interrupted: cached.interrupted };
      }
      return { idle: false, stale: false, lastAssistantSnippet: cached.lastAssistantSnippet, currentAction: cached.currentAction, reset: cached.reset, lastEntryTs: cached.lastEntryTs, staleMs: cached.staleMs, interrupted: cached.interrupted };
    }

    const handle = await fs.open(jsonlPath, 'r');
    try {
      const elapsed = Date.now() - stat.mtimeMs;

      const readSize = Math.min(stat.size, JSONL_TAIL_SIZE);
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, stat.size - readSize);
      const lines = buffer.toString('utf-8').split('\n').filter((l) => l.trim());

      let scan = scanLines(lines, elapsed);
      let extracted = extractAssistantInfo(lines);
      let openBackgroundTasks = countOpenBackgroundTasks(lines);

      if (!scan.matched && stat.size > JSONL_TAIL_SIZE) {
        const extSize = Math.min(stat.size, JSONL_EXTENDED_TAIL_SIZE);
        const extBuffer = Buffer.alloc(extSize);
        await handle.read(extBuffer, 0, extSize, stat.size - extSize);
        const extLines = extBuffer.toString('utf-8').split('\n').filter((l) => l.trim());
        scan = scanLines(extLines, elapsed);
        if (!extracted.lastAssistantSnippet && !extracted.currentAction) extracted = extractAssistantInfo(extLines);
        openBackgroundTasks = countOpenBackgroundTasks(extLines);
      }

      if (jsonlIdleCache.size >= MAX_JSONL_CACHE) {
        jsonlIdleCache.delete(jsonlIdleCache.keys().next().value!);
      }
      jsonlIdleCache.set(jsonlPath, { mtimeMs: stat.mtimeMs, idle: scan.idle, stale: scan.stale, needsStaleRecheck: scan.needsStaleRecheck, staleMs: scan.staleMs, lastAssistantSnippet: extracted.lastAssistantSnippet, currentAction: extracted.currentAction, reset: extracted.reset, lastEntryTs: scan.lastEntryTs, interrupted: scan.interrupted });
      return { idle: scan.idle, stale: scan.stale, lastAssistantSnippet: extracted.lastAssistantSnippet, currentAction: extracted.currentAction, reset: extracted.reset, lastEntryTs: scan.lastEntryTs, staleMs: scan.staleMs, interrupted: scan.interrupted , openBackgroundTasks };
    } finally {
      await handle.close();
    }
  } catch {
    return emptySnapshot();
  }
};

export const __testing = {
  extractAssistantInfo,
  scanLines,
  countOpenBackgroundTasks,
};
