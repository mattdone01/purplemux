import fs from 'fs/promises';
import { EMPTY_PENDING, splitCompleteLines } from '@/lib/buffer-lines';
import { createLogger } from '@/lib/logger';
import { summarizeToolCall, summarizeToolResult } from '@/lib/session-parser';
import { grokSessionIdFromJsonlPath } from '@/lib/providers/grok/paths';
import type {
  IChunkReadResult,
  IIncrementalResult,
  ITimelineAssistantMessage,
  ITimelineEntry,
  ITimelineToolCall,
  TToolName,
  TToolStatus,
} from '@/types/timeline';

const log = createLogger('grok-parser');

export const GROK_PROVIDER_ID = 'grok';

/**
 * `costUsdTicks` is USD × 10^10. Read off two real headless turns whose JSON
 * output carried both figures: `total_cost_usd 0.01009732` /
 * `total_cost_usd_ticks 100973200`.
 */
export const GROK_COST_TICKS_PER_USD = 1e10;

/**
 * Grok Build's canonical tool names, mapped onto the names purplemux's timeline
 * already renders icons and summaries for. The alias table in
 * `~/.grok/docs/user-guide/10-hooks.md` is the same mapping read the other way.
 */
const TOOL_NAME_ALIASES: Record<string, TToolName> = {
  read_file: 'Read',
  search_replace: 'Edit',
  write_file: 'Write',
  run_terminal_command: 'Bash',
  grep: 'Grep',
  list_dir: 'Glob',
  spawn_subagent: 'Agent',
};

/** grok names the read target `target_file`; every other field it uses already matches. */
const INPUT_KEY_ALIASES: Record<string, string> = {
  target_file: 'file_path',
};

export interface IGrokUpdate {
  ordinal: number;
  timestamp: number;
  sessionId: string;
  kind: string;
  update: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const tryParse = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/**
 * One `updates.jsonl` line:
 * `{timestamp: <epoch s>, method: "session/update" | "_x.ai/session/update",
 *   params: {sessionId, update: {sessionUpdate, …}, _meta: {agentTimestampMs, …}}}`.
 *
 * `_x.ai/session/update` is the vendor extension channel (it carries
 * `turn_completed`); both channels are read, because the discriminator that
 * matters is `sessionUpdate`, not the method.
 */
export const parseGrokUpdateLine = (line: string, ordinal: number): IGrokUpdate | null => {
  const parsed = tryParse(line);
  if (!isRecord(parsed)) return null;
  const params = parsed.params;
  if (!isRecord(params)) return null;
  const update = params.update;
  if (!isRecord(update)) return null;
  const kind = asString(update.sessionUpdate);
  if (!kind) return null;

  const meta = isRecord(params._meta) ? params._meta : {};
  const agentMs = asNumber(meta.agentTimestampMs);
  const seconds = asNumber(parsed.timestamp);

  return {
    ordinal,
    timestamp: agentMs ?? (seconds !== null ? seconds * 1000 : 0),
    sessionId: asString(params.sessionId),
    kind,
    update,
  };
};

const chunkText = (update: Record<string, unknown>): string => {
  const content = update.content;
  if (typeof content === 'string') return content;
  if (isRecord(content) && content.type === 'text') return asString(content.text);
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && part.type === 'text' ? asString(part.text) : ''))
      .join('');
  }
  return '';
};

type TRunKind = 'user-message' | 'assistant-message' | 'thinking';

const RUN_KIND_BY_UPDATE: Record<string, TRunKind> = {
  user_message_chunk: 'user-message',
  agent_message_chunk: 'assistant-message',
  agent_thought_chunk: 'thinking',
};

/**
 * Chunks stream: one logical message arrives as any number of
 * `*_message_chunk` / `*_thought_chunk` updates in a row. Consecutive chunks of
 * one kind collapse into a single entry so `seq` counts messages rather than
 * network frames — story 02's identity contract is per entry, and a client that
 * saw one entry per chunk could never match a re-read of the same file.
 */
interface IRun {
  kind: TRunKind;
  seq: number;
  timestamp: number;
  parts: string[];
}

interface IToolCallState {
  seq: number;
  toolName: TToolName;
  settled: boolean;
}

export interface IGrokParseState {
  sessionId: string;
  run: IRun | null;
  toolCalls: Map<string, IToolCallState>;
  /** The assistant entry a later `turn_completed` attaches model + usage to. */
  lastAssistant: ITimelineAssistantMessage | null;
}

export const createGrokParseState = (sessionId: string): IGrokParseState => ({
  sessionId,
  run: null,
  toolCalls: new Map(),
  lastAssistant: null,
});

export const grokEntryId = (sessionId: string, seq: number): string =>
  `${GROK_PROVIDER_ID}:${sessionId}:${seq}`;

const runEntry = (state: IGrokParseState, run: IRun): ITimelineEntry | null => {
  const text = run.parts.join('');
  if (!text.trim()) return null;
  const id = grokEntryId(state.sessionId, run.seq);
  if (run.kind === 'user-message') {
    return { type: 'user-message', id, seq: run.seq, timestamp: run.timestamp, text: text.trim() };
  }
  if (run.kind === 'thinking') {
    return { type: 'thinking', id, seq: run.seq, timestamp: run.timestamp, thinking: text.trim() };
  }
  return { type: 'assistant-message', id, seq: run.seq, timestamp: run.timestamp, markdown: text.trim() };
};

const flushRun = (state: IGrokParseState, into: ITimelineEntry[]): void => {
  if (!state.run) return;
  const entry = runEntry(state, state.run);
  state.run = null;
  if (!entry) return;
  if (entry.type === 'assistant-message') state.lastAssistant = entry;
  into.push(entry);
};

const normalizeToolInput = (rawInput: unknown): Record<string, unknown> => {
  if (!isRecord(rawInput)) return {};
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawInput)) {
    normalized[INPUT_KEY_ALIASES[key] ?? key] = value;
  }
  return normalized;
};

/** `_meta['x.ai/tool'].name` is the tool's real identity; `title` becomes prose after the first update. */
const toolNameFrom = (update: Record<string, unknown>): TToolName => {
  const meta = isRecord(update._meta) ? update._meta : {};
  const xai = isRecord(meta['x.ai/tool']) ? meta['x.ai/tool'] as Record<string, unknown> : {};
  const raw = asString(xai.name) || asString(update.title);
  return TOOL_NAME_ALIASES[raw] ?? raw ?? '';
};

const TERMINAL_STATUS: Record<string, TToolStatus> = {
  completed: 'success',
  failed: 'error',
  error: 'error',
  cancelled: 'error',
};

/**
 * A tool result's text. grok returns ACP `content` blocks — `{type:'content',
 * content:{type:'text',text}}` for output and `{type:'diff', …}` for an edit —
 * plus a `rawOutput` envelope tagged with the tool variant.
 */
const toolResultText = (update: Record<string, unknown>): string => {
  const content = update.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'content' && isRecord(block.content)) {
        parts.push(asString(block.content.text));
      } else if (block.type === 'diff') {
        parts.push(`${asString(block.path)}: ${asString(block.oldText)} → ${asString(block.newText)}`);
      }
    }
    const joined = parts.filter(Boolean).join('\n');
    if (joined) return joined;
  }
  const rawOutput = update.rawOutput;
  if (isRecord(rawOutput)) {
    for (const value of Object.values(rawOutput)) {
      if (isRecord(value) && typeof value.output_for_prompt === 'string') return value.output_for_prompt;
      if (isRecord(value) && typeof value.content === 'string') return value.content;
    }
  }
  return '';
};

const attachTurnUsage = (state: IGrokParseState, update: Record<string, unknown>): void => {
  const assistant = state.lastAssistant;
  if (!assistant) return;
  const usage = isRecord(update.usage) ? update.usage : null;
  if (!usage) return;

  const modelUsage = isRecord(usage.modelUsage) ? usage.modelUsage : {};
  const model = Object.keys(modelUsage)[0];
  if (model) assistant.model = model;
  assistant.stopReason = asString(update.stop_reason) || undefined;
  assistant.usage = {
    input_tokens: asNumber(usage.inputTokens) ?? 0,
    output_tokens: asNumber(usage.outputTokens) ?? 0,
    cache_read_input_tokens: asNumber(usage.cachedReadTokens) ?? 0,
    cache_creation_input_tokens: asNumber(usage.cacheCreationTokens) ?? 0,
  };
};

const applyToolCall = (
  state: IGrokParseState,
  entry: IGrokUpdate,
  into: ITimelineEntry[],
): void => {
  const update = entry.update;
  const toolUseId = asString(update.toolCallId);
  if (!toolUseId) return;

  const toolName = toolNameFrom(update);
  const input = normalizeToolInput(update.rawInput);
  const call: ITimelineToolCall = {
    type: 'tool-call',
    id: grokEntryId(state.sessionId, entry.ordinal),
    seq: entry.ordinal,
    timestamp: entry.timestamp,
    toolUseId,
    toolName,
    summary: summarizeToolCall(toolName, input),
    status: 'pending',
  };
  state.toolCalls.set(toolUseId, { seq: entry.ordinal, toolName, settled: false });
  into.push(call);
};

const applyToolCallUpdate = (
  state: IGrokParseState,
  entry: IGrokUpdate,
  into: ITimelineEntry[],
): void => {
  const update = entry.update;
  const toolUseId = asString(update.toolCallId);
  if (!toolUseId) return;

  const status = TERMINAL_STATUS[asString(update.status)];
  // A `tool_call_update` with no status refines the call's title, locations or
  // input while it runs. Only the terminal one is an entry; emitting the others
  // would put several results under one call.
  if (!status) return;

  const known = state.toolCalls.get(toolUseId);
  if (known?.settled) return;
  if (known) known.settled = true;

  const isError = status === 'error';
  into.push({
    type: 'tool-result',
    id: grokEntryId(state.sessionId, entry.ordinal),
    seq: entry.ordinal,
    timestamp: entry.timestamp,
    toolUseId,
    isError,
    summary: summarizeToolResult(toolResultText(update), isError),
  });
};

export interface IGrokParseOutcome {
  entries: ITimelineEntry[];
  errorCount: number;
  /** Highest ordinal consumed, so the caller can resume numbering. */
  nextOrdinal: number;
}

/**
 * Parses `lines` starting at `startOrdinal`. An open chunk run is flushed at the
 * end of every batch and re-emitted, larger, by the next one: entries key on
 * `(sessionKey, seq)`, so re-sending the same seq upserts rather than
 * duplicates, which is what lets a streaming message grow in place.
 */
export const parseGrokLines = (
  lines: string[],
  startOrdinal: number,
  state: IGrokParseState,
): IGrokParseOutcome => {
  const entries: ITimelineEntry[] = [];
  let errorCount = 0;
  let ordinal = startOrdinal;

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseGrokUpdateLine(line, ordinal);
    ordinal += 1;
    if (!parsed) {
      errorCount += 1;
      continue;
    }
    if (!state.sessionId && parsed.sessionId) state.sessionId = parsed.sessionId;

    const runKind = RUN_KIND_BY_UPDATE[parsed.kind];
    if (runKind) {
      if (state.run && state.run.kind === runKind) {
        state.run.parts.push(chunkText(parsed.update));
        continue;
      }
      flushRun(state, entries);
      state.run = {
        kind: runKind,
        seq: parsed.ordinal,
        timestamp: parsed.timestamp,
        parts: [chunkText(parsed.update)],
      };
      continue;
    }

    flushRun(state, entries);

    if (parsed.kind === 'tool_call') applyToolCall(state, parsed, entries);
    else if (parsed.kind === 'tool_call_update') applyToolCallUpdate(state, parsed, entries);
    else if (parsed.kind === 'turn_completed') attachTurnUsage(state, parsed.update);
    // Any other `sessionUpdate` is ignored on purpose: grok may add kinds, and
    // an unknown one must not become an error-notice in the transcript.
  }

  // Flushed rather than carried: the run is re-emitted at the same seq next
  // batch, so a live message is visible while it is still being written.
  const openRun = state.run;
  if (openRun) {
    const entry = runEntry(state, openRun);
    if (entry) {
      if (entry.type === 'assistant-message') state.lastAssistant = entry;
      entries.push(entry);
    }
  }

  return { entries, errorCount, nextOrdinal: ordinal };
};

/** Whole-content parse, for history paging and search extraction. */
export const parseGrokContent = (content: string, sessionId = ''): ITimelineEntry[] => {
  const state = createGrokParseState(sessionId);
  return parseGrokLines(content.split('\n'), 0, state).entries;
};

const emptyChunk = (): IChunkReadResult => ({
  entries: [],
  startByteOffset: 0,
  fileSize: 0,
  hasMore: false,
  errorCount: 0,
});

/**
 * Incremental reader for the live timeline socket.
 *
 * Unlike the Claude and Codex parsers, `seq` here is the update's ordinal
 * rather than its byte offset, so a window cannot be numbered without the lines
 * before it. Every read therefore starts from the file head; grok writes one
 * conversation per file, which keeps that bounded.
 */
export class GrokParser {
  private readonly jsonlPath: string;
  private readonly sessionId: string;
  private lastOffset = 0;
  private pendingBuffer: Buffer = EMPTY_PENDING;
  private ordinal = 0;
  private state: IGrokParseState;

  constructor(jsonlPath: string) {
    this.jsonlPath = jsonlPath;
    this.sessionId = grokSessionIdFromJsonlPath(jsonlPath) ?? '';
    this.state = createGrokParseState(this.sessionId);
  }

  reset(): void {
    this.lastOffset = 0;
    this.pendingBuffer = EMPTY_PENDING;
    this.ordinal = 0;
    this.state = createGrokParseState(this.sessionId);
  }

  dispose(): void {
    this.state.toolCalls.clear();
    this.pendingBuffer = EMPTY_PENDING;
  }

  get offset(): number {
    return this.lastOffset;
  }

  get path(): string {
    return this.jsonlPath;
  }

  async parseTail(maxEntries: number): Promise<IChunkReadResult> {
    this.reset();
    let content: string;
    try {
      content = await fs.readFile(this.jsonlPath, 'utf-8');
    } catch {
      return emptyChunk();
    }

    const bytes = Buffer.from(content, 'utf-8');
    const fileSize = bytes.length;
    const complete = splitCompleteLines(bytes, (line) => tryParse(line) !== undefined);
    const { entries, errorCount, nextOrdinal } = parseGrokLines(complete.content.split('\n'), 0, this.state);

    // `lastOffset` counts every byte read, pending ones included; the partial
    // record is re-prepended on the next read rather than re-read from disk.
    this.lastOffset = fileSize;
    this.pendingBuffer = complete.pending;
    this.ordinal = nextOrdinal;

    const hasMore = entries.length > maxEntries;
    const delivered = hasMore ? entries.slice(-maxEntries) : entries;
    return {
      entries: delivered,
      // The cursor the client pages backwards from — the oldest seq it now
      // holds, or 0 when the whole session fit and there is nothing older. It
      // must be 0 in that case, or `canLoadOlder` would arm a control with
      // nothing to fetch.
      startByteOffset: hasMore ? delivered[0]?.seq ?? 0 : 0,
      fileSize,
      hasMore,
      errorCount,
    };
  }

  async parseIncremental(): Promise<IIncrementalResult> {
    let handle;
    try {
      handle = await fs.open(this.jsonlPath, 'r');
    } catch {
      return { newEntries: [], newOffset: this.lastOffset, pendingBuffer: this.pendingBuffer };
    }

    try {
      const { size } = await handle.stat();
      // A shrink means a rewind or a compaction rewrote the file; ordinals from
      // the old content no longer describe it, so the parse restarts.
      if (size < this.lastOffset) {
        this.reset();
        const tail = await this.parseTail(Number.MAX_SAFE_INTEGER);
        return { newEntries: tail.entries, newOffset: this.lastOffset, pendingBuffer: this.pendingBuffer };
      }
      if (this.lastOffset >= size) {
        return { newEntries: [], newOffset: this.lastOffset, pendingBuffer: this.pendingBuffer };
      }

      const buffer = Buffer.alloc(size - this.lastOffset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.lastOffset);
      const bytes = this.pendingBuffer.length > 0
        ? Buffer.concat([this.pendingBuffer, buffer.subarray(0, bytesRead)])
        : buffer.subarray(0, bytesRead);
      const { content, pending } = splitCompleteLines(bytes, (line) => tryParse(line) !== undefined);

      const { entries, nextOrdinal } = parseGrokLines(content.split('\n'), this.ordinal, this.state);
      this.ordinal = nextOrdinal;
      this.lastOffset = size;
      this.pendingBuffer = pending;
      return { newEntries: entries, newOffset: size, pendingBuffer: pending };
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err, path: this.jsonlPath }, 'grok incremental parse failed');
      return { newEntries: [], newOffset: this.lastOffset, pendingBuffer: this.pendingBuffer };
    } finally {
      await handle.close().catch(() => {});
    }
  }
}

export const createGrokParser = (jsonlPath: string): GrokParser => new GrokParser(jsonlPath);

export const readTailGrokEntries = async (
  jsonlPath: string,
  maxEntries: number,
): Promise<IChunkReadResult> => createGrokParser(jsonlPath).parseTail(maxEntries);

/**
 * Older entries for `/api/timeline/entries`. grok's `seq` is an ordinal, so the
 * whole file is parsed and the window is taken from the entry list rather than
 * from a byte range.
 */
export const readGrokEntriesBefore = async (
  jsonlPath: string,
  beforeSeq: number,
  maxEntries: number,
): Promise<IChunkReadResult> => {
  let content: string;
  try {
    content = await fs.readFile(jsonlPath, 'utf-8');
  } catch {
    return emptyChunk();
  }
  const all = parseGrokContent(content, grokSessionIdFromJsonlPath(jsonlPath) ?? '');
  const older = all.filter((entry) => (entry.seq ?? 0) < beforeSeq);
  const entries = older.slice(-maxEntries);
  return {
    entries,
    startByteOffset: entries.length > 0 ? entries[0].seq ?? 0 : 0,
    fileSize: Buffer.byteLength(content, 'utf-8'),
    hasMore: older.length > entries.length,
    errorCount: 0,
  };
};
