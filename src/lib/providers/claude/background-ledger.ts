import fs from 'fs/promises';
import path from 'path';

/**
 * Background work the Claude harness starts for the agent and reports back on
 * later. Measured on Claude Code 2.1.283 (2026-09-26, fixtures in
 * `tests/fixtures/claude-background/`):
 *
 * Starts arrive as a `user` tool result whose `toolUseResult` names the task:
 * - `Bash(run_in_background)` and a foreground command moved to the background
 *   on its timeout: `backgroundTaskId`.
 * - `Agent` launched async: `isAsync: true` + `agentId`.
 * - `Monitor`: `taskId` + `timeoutMs`; it ends by itself at the timeout.
 * - `SendMessage` to a finished agent: `resumedAgentId`; the agent runs again.
 *
 * Ends arrive as a `<task-notification>` carrying `<task-id>`, delivered as a
 * `queue-operation` (the agent was busy), a `queued_command` attachment, or a
 * `user` message whose content is the notification (the agent was idle); the
 * queue's later `remove` of the same text is bookkeeping, not an event. A
 * notification WITHOUT `<status>` is a Monitor event and ends nothing, unless
 * its event is the Monitor's expiry notice. A `TaskStop` result ends its task.
 *
 * Starts can be many turns before the turn that waits on them, so the ledger
 * covers the whole transcript: it is read once, then only the appended bytes.
 *
 * A subagent's own starts live in `<session>/subagents/agent-<id>.jsonl`
 * (sidechain lines). A foreground Bash it moves to the background on its
 * timeout keeps running after the subagent returns, and the completion lands
 * in the MAIN transcript (story 37: tab-dTsAzt, 2026-09-26, three such shells
 * read as zero open work). So the session's ledger merges the main file and
 * every subagent file. Shell and Monitor ids are single-use: any end closes
 * them, whichever file holds it. An agent id is reused on resume, so an end
 * closes an agent only when it is not older than that agent's start.
 *
 * A subagent file's notification is a user line the harness marks
 * `origin.kind: "task-notification"`, its text prefixed with
 * `[SYSTEM NOTIFICATION - NOT USER INPUT]`. It also WAKES that subagent: an
 * async agent that had completed runs again to read it, and the main file
 * records no resume, only the agent's second completion (agent adb9dae4,
 * 15:46:11 → woken 15:50:30 → 15:51:37). Measured over the live sessions on
 * 2026-09-26: all 94 such deliveries were followed by that agent's end in the
 * main file. A wake counts only for an agent some file started as async.
 */

export type TBackgroundTaskKind = 'shell' | 'agent' | 'monitor';

export interface IBackgroundTask {
  id: string;
  kind: TBackgroundTaskKind;
  startedAt: number | null;
  /** Monitors end on their own at `startedAt + timeoutMs`. */
  expiresAt: number | null;
  outputFile: string | null;
}

export interface IBackgroundLedger {
  open: Map<string, IBackgroundTask>;
  /** Newest Monitor event per open task; an event is activity. */
  lastEventAt: Map<string, number>;
  /**
   * Newest end per task id, including ids this file never opened: a subagent's
   * shell ends in the main file. An end with no timestamp is recorded as
   * +Infinity (it closes every start).
   */
  endedAt: Map<string, number>;
  /** Ids this file started as async agents (launch or resume); only these can be woken. */
  asyncAgents: Set<string>;
  /** Newest harness delivery into a subagent file, by that file's agent id: the agent runs again from then. */
  wokenAt: Map<string, number>;
}

/** Which file a line comes from: the main transcript skips sidechain lines; a subagent transcript is all sidechain. */
export type TLedgerSource = 'main' | 'subagent';

// A Monitor's expiry notice can land a little after its deadline; past this
// grace the task is over even if the notice was never written.
export const MONITOR_EXPIRY_GRACE_MS = 2 * 60 * 1000;

const LINE_HINTS = ['backgroundTaskId', '"isAsync"', '"taskId"', 'resumedAgentId', 'task-notification', '"task_id"'];
const NOTIFICATION_PATTERN = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID_PATTERN = /<task-id>\s*([A-Za-z0-9_-]+)\s*<\/task-id>/;
const STATUS_PATTERN = /<status>\s*([a-z_]+)\s*<\/status>/;
const EVENT_PATTERN = /<event>([\s\S]*?)<\/event>/;
const OUTPUT_FILE_PATTERN = /Output is being written to:\s*(\S+?\.output)\b/;
const MONITOR_EXPIRED_PREFIX = '[Monitor expired';

export const createBackgroundLedger = (): IBackgroundLedger => ({
  open: new Map(),
  lastEventAt: new Map(),
  endedAt: new Map(),
  asyncAgents: new Set(),
  wokenAt: new Map(),
});

type TEntry = Record<string, unknown> & {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  message?: { content?: unknown };
  toolUseResult?: unknown;
  operation?: string;
  content?: unknown;
  attachment?: { type?: string; prompt?: unknown };
  origin?: { kind?: unknown };
  agentId?: unknown;
};

const timestampOf = (entry: TEntry): number | null => {
  const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(ts) ? ts : null;
};

const toolResultText = (entry: TEntry): string => {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<{ type?: string; content?: unknown }>) {
    if (block.type !== 'tool_result') continue;
    if (typeof block.content === 'string') parts.push(block.content);
    if (Array.isArray(block.content)) {
      for (const inner of block.content as Array<{ text?: unknown }>) {
        if (typeof inner.text === 'string') parts.push(inner.text);
      }
    }
  }
  return parts.join('\n');
};

const isToolResult = (entry: TEntry): boolean =>
  Array.isArray(entry.message?.content)
  && (entry.message!.content as Array<{ type?: string }>).some((b) => b?.type === 'tool_result');

/** Notification text a transcript entry delivers, or null when it delivers none. */
const notificationTextOf = (entry: TEntry): string | null => {
  if (entry.type === 'queue-operation') {
    return entry.operation === 'enqueue' && typeof entry.content === 'string' ? entry.content : null;
  }
  if (entry.type === 'attachment') {
    return entry.attachment?.type === 'queued_command' && typeof entry.attachment.prompt === 'string'
      ? entry.attachment.prompt
      : null;
  }
  if (entry.type !== 'user' || isToolResult(entry)) return null;
  const content = entry.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as Array<{ type?: string; text?: unknown }>)
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n')
      : '';
  // The harness marks its own deliveries; a subagent's carry a warning prefix.
  if (entry.origin?.kind === 'task-notification') return text;
  // A person quoting a notification mid-message is not a delivery.
  return text.trimStart().startsWith('<task-notification>') ? text : null;
};

const startOf = (entry: TEntry): IBackgroundTask | null => {
  const result = entry.toolUseResult;
  if (typeof result !== 'object' || result === null) return null;
  const r = result as Record<string, unknown>;
  const startedAt = timestampOf(entry);
  if (typeof r.backgroundTaskId === 'string' && r.backgroundTaskId) {
    const outputFile = toolResultText(entry).match(OUTPUT_FILE_PATTERN)?.[1] ?? null;
    return { id: r.backgroundTaskId, kind: 'shell', startedAt, expiresAt: null, outputFile };
  }
  if (r.isAsync === true && typeof r.agentId === 'string' && r.agentId) {
    const outputFile = typeof r.outputFile === 'string' ? r.outputFile : null;
    return { id: r.agentId, kind: 'agent', startedAt, expiresAt: null, outputFile };
  }
  if (typeof r.taskId === 'string' && r.taskId && typeof r.timeoutMs === 'number') {
    const expiresAt = startedAt !== null ? startedAt + r.timeoutMs : null;
    return { id: r.taskId, kind: 'monitor', startedAt, expiresAt, outputFile: null };
  }
  if (typeof r.resumedAgentId === 'string' && r.resumedAgentId) {
    return { id: r.resumedAgentId, kind: 'agent', startedAt, expiresAt: null, outputFile: null };
  }
  return null;
};

const stoppedTaskOf = (entry: TEntry): string | null => {
  const result = entry.toolUseResult;
  if (typeof result !== 'object' || result === null) return null;
  const r = result as Record<string, unknown>;
  return typeof r.task_id === 'string' && typeof r.message === 'string' && r.message.startsWith('Successfully stopped')
    ? r.task_id
    : null;
};

const end = (ledger: IBackgroundLedger, id: string, at: number | null): void => {
  ledger.open.delete(id);
  ledger.lastEventAt.delete(id);
  const when = at ?? Number.POSITIVE_INFINITY;
  ledger.endedAt.set(id, Math.max(ledger.endedAt.get(id) ?? Number.NEGATIVE_INFINITY, when));
};

export const applyBackgroundLine = (ledger: IBackgroundLedger, line: string, source: TLedgerSource = 'main'): void => {
  if (!LINE_HINTS.some((hint) => line.includes(hint))) return;
  let entry: TEntry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof entry !== 'object' || entry === null) return;
  if (entry.isSidechain && source === 'main') return;

  if (entry.type === 'user') {
    const started = startOf(entry);
    if (started) ledger.open.set(started.id, { ...started, outputFile: started.outputFile ?? ledger.open.get(started.id)?.outputFile ?? null });
    if (started?.kind === 'agent') ledger.asyncAgents.add(started.id);
    const stopped = stoppedTaskOf(entry);
    if (stopped) end(ledger, stopped, timestampOf(entry));
  }

  const text = notificationTextOf(entry);
  if (!text) return;
  const deliveredAt = timestampOf(entry);
  // A wake needs its time: an untimed wake could never be closed by a later end (review r2).
  if (source === 'subagent' && deliveredAt !== null && entry.origin?.kind === 'task-notification' && typeof entry.agentId === 'string' && entry.agentId) {
    ledger.wokenAt.set(entry.agentId, Math.max(ledger.wokenAt.get(entry.agentId) ?? Number.NEGATIVE_INFINITY, deliveredAt));
  }
  for (const match of text.matchAll(NOTIFICATION_PATTERN)) {
    const body = match[1];
    const id = body.match(TASK_ID_PATTERN)?.[1];
    if (!id) continue;
    const event = body.match(EVENT_PATTERN)?.[1]?.trim() ?? '';
    // A Monitor event's own text may quote a status tag; only the envelope counts.
    const envelope = body.replace(EVENT_PATTERN, '');
    if (STATUS_PATTERN.test(envelope) || event.startsWith(MONITOR_EXPIRED_PREFIX)) {
      end(ledger, id, deliveredAt);
    } else if (deliveredAt !== null) {
      // Kept for ids this file never opened too: a subagent's Monitor reports in the main file.
      ledger.lastEventAt.set(id, deliveredAt);
    }
  }
};

/**
 * Tasks still open at `now`: never ended, not a Monitor past its deadline, and
 * not started before `since` (the agent process's start; a task open when an
 * earlier process died never reports back).
 */
export const openBackgroundTasks = (ledger: IBackgroundLedger, now: number, since?: number | null): IBackgroundTask[] =>
  [...ledger.open.values()].filter((task) =>
    (task.expiresAt === null || now <= task.expiresAt + MONITOR_EXPIRY_GRACE_MS)
    && (since == null || task.startedAt === null || task.startedAt >= since));

interface ILedgerFileState {
  ino: number;
  offset: number;
  ledger: IBackgroundLedger;
}

// One per transcript: the main file and each subagent file of every live tab.
// Measured 2026-09-26: 151 subagent files over all sessions, at most 29 in one.
const MAX_LEDGER_FILES = 4096;
const READ_CHUNK = 1 << 20;

const g = globalThis as unknown as { __ptClaudeBackgroundLedgers?: Map<string, ILedgerFileState> };
if (!g.__ptClaudeBackgroundLedgers) g.__ptClaudeBackgroundLedgers = new Map();
const ledgers = g.__ptClaudeBackgroundLedgers;

/**
 * The ledger of one transcript file, brought up to date with the bytes
 * appended since the last read. A replaced or truncated file is read again
 * from the start. Only complete lines are consumed; a partial last line waits
 * for the next read.
 */
const readFileLedger = async (
  jsonlPath: string,
  source: TLedgerSource,
  known?: { ino: number; size: number },
): Promise<IBackgroundLedger> => {
  const stat = known ?? await fs.stat(jsonlPath);
  let state = ledgers.get(jsonlPath);
  if (!state || state.ino !== stat.ino || stat.size < state.offset) {
    state = { ino: stat.ino, offset: 0, ledger: createBackgroundLedger() };
  }
  ledgers.delete(jsonlPath);
  ledgers.set(jsonlPath, state);
  while (ledgers.size > MAX_LEDGER_FILES) ledgers.delete(ledgers.keys().next().value!);

  if (stat.size === state.offset) return state.ledger;
  const handle = await fs.open(jsonlPath, 'r');
  try {
    let carry = '';
    let position = state.offset;
    while (position < stat.size) {
      const size = Math.min(READ_CHUNK, stat.size - position);
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const text = carry + buffer.subarray(0, bytesRead).toString('utf-8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        carry = text;
        continue;
      }
      for (const line of text.slice(0, lastNewline).split('\n')) {
        if (line.trim()) applyBackgroundLine(state.ledger, line, source);
      }
      carry = text.slice(lastNewline + 1);
    }
    state.offset = position - Buffer.byteLength(carry, 'utf-8');
  } finally {
    await handle.close();
  }
  return state.ledger;
};

const subagentsDirOf = (jsonlPath: string): string => path.join(jsonlPath.replace(/\.jsonl$/, ''), 'subagents');

const subagentFiles = async (jsonlPath: string): Promise<string[]> => {
  const dir = subagentsDirOf(jsonlPath);
  try {
    return (await fs.readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort().map((name) => path.join(dir, name));
  } catch {
    return [];
  }
};

const maxInto = (map: Map<string, number>, id: string, at: number): void => {
  map.set(id, Math.max(map.get(id) ?? Number.NEGATIVE_INFINITY, at));
};

/** Whether an end closes a start: always for single-use shell and Monitor ids; for an agent, only an end not older than the start. */
const closes = (task: IBackgroundTask, endedAt: number | undefined): boolean =>
  endedAt !== undefined && (task.kind !== 'agent' || task.startedAt === null || endedAt >= task.startedAt);

/**
 * One ledger from several files: a task is open when some file opened it (or
 * woke it, for a known async agent) and no end closes it.
 */
export const mergeLedgers = (ledgers: IBackgroundLedger[]): IBackgroundLedger => {
  const merged = createBackgroundLedger();
  for (const ledger of ledgers) {
    for (const [id, at] of ledger.endedAt) maxInto(merged.endedAt, id, at);
    for (const id of ledger.asyncAgents) merged.asyncAgents.add(id);
    for (const [id, at] of ledger.wokenAt) maxInto(merged.wokenAt, id, at);
  }
  const candidates: IBackgroundTask[] = ledgers.flatMap((ledger) => [...ledger.open.values()]);
  for (const [id, at] of merged.wokenAt) {
    if (merged.asyncAgents.has(id)) candidates.push({ id, kind: 'agent', startedAt: at, expiresAt: null, outputFile: null });
  }
  for (const task of candidates) {
    if (closes(task, merged.endedAt.get(task.id))) continue;
    const known = merged.open.get(task.id);
    if (known && (known.startedAt ?? Number.NEGATIVE_INFINITY) >= (task.startedAt ?? Number.NEGATIVE_INFINITY)) {
      if (!known.outputFile && task.outputFile) merged.open.set(task.id, { ...known, outputFile: task.outputFile });
      continue;
    }
    merged.open.set(task.id, { ...task, outputFile: task.outputFile ?? known?.outputFile ?? null });
  }
  for (const ledger of ledgers) {
    for (const [id, at] of ledger.lastEventAt) {
      if (merged.open.has(id)) maxInto(merged.lastEventAt, id, at);
    }
  }
  return merged;
};

/**
 * The session's ledger: the main transcript plus every subagent transcript,
 * each read incrementally. A subagent file last written before `since` (the
 * agent process's start) is not read: every start and wake in it predates
 * `since` and is filtered anyway, and its ends can only close those. A
 * subagent file that cannot be read is skipped; the main file's read failure
 * is thrown to the caller.
 */
export const readBackgroundLedger = async (jsonlPath: string, since?: number | null): Promise<IBackgroundLedger> => {
  const main = await readFileLedger(jsonlPath, 'main');
  const subs: IBackgroundLedger[] = [];
  for (const file of await subagentFiles(jsonlPath)) {
    try {
      const stat = await fs.stat(file);
      if (since != null && stat.mtimeMs < since) continue;
      subs.push(await readFileLedger(file, 'subagent', stat));
    } catch {
      // Removed between the listing and the read.
    }
  }
  return mergeLedgers([main, ...subs]);
};

const mtimeOf = async (file: string): Promise<number | null> => {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Newest sign of life of a transcript's background work: the transcript
 * itself, each open task's output file (an async agent's output file links to
 * its subagent transcript), each subagent transcript, and each Monitor event.
 * The main transcript alone misses all of these (L19, L25).
 */
export const latestBackgroundActivityAt = async (
  jsonlPath: string,
  ledger: IBackgroundLedger,
  now: number,
  since?: number | null,
): Promise<number | null> => {
  const candidates: Array<number | null> = [await mtimeOf(jsonlPath)];
  const open = openBackgroundTasks(ledger, now, since);
  const taskDirs = new Set<string>();
  for (const task of open) {
    if (task.outputFile) {
      candidates.push(await mtimeOf(task.outputFile));
      taskDirs.add(path.dirname(task.outputFile));
    }
    candidates.push(ledger.lastEventAt.get(task.id) ?? null);
  }
  for (const task of open) {
    if (task.outputFile) continue;
    for (const dir of taskDirs) candidates.push(await mtimeOf(path.join(dir, `${task.id}.output`)));
  }
  for (const file of await subagentFiles(jsonlPath)) candidates.push(await mtimeOf(file));
  const known = candidates.filter((t): t is number => t !== null);
  return known.length ? Math.max(...known) : null;
};

export const __testing = {
  ledgers,
};
