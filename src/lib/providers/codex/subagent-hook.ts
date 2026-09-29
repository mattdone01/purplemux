import fs from 'fs/promises';
import { codexProvider } from '@/lib/providers/codex';
import type { ICodexHookPayload } from '@/lib/providers/codex/hook-payload';

/**
 * A Codex native subagent (a `spawn_agent` thread) runs inside its parent's process and pane, so
 * its hooks carry the parent's tmux session and launch generation. Applied to the parent's tab,
 * they re-key it: measured 2026-09-29 on tab-QizeO4, a subagent's hooks set the tab's transcript
 * to the subagent's rollout (the model observation then reported `session-identity-mismatch`)
 * and its tool calls set the tab busy again after the root's Stop, so readiness never cleared
 * and every send to the tab waited.
 *
 * A hook is the subagent's when either:
 * - its transcript names another session than its own `session_id` (the case measured: the tab
 *   kept the root's id and took the subagent's transcript); or
 * - its transcript's first line, the `session_meta` record, says the session is a subagent
 *   (`source.subagent` or `thread_source: "subagent"`), which covers a subagent that reports its
 *   own id.
 */

/** A transcript's first line is its session_meta; it is small, but never read past this. */
const FIRST_LINE_MAX_BYTES = 64 * 1024;
/** Transcripts are immutable in their first line; remember the answer per path (bounded). */
const MAX_CACHED_TRANSCRIPTS = 512;
const subagentByTranscript = new Map<string, boolean>();

export const isSubagentSessionMeta = (line: string): boolean => {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return false;
  }
  if (!record || typeof record !== 'object') return false;
  const { type, payload } = record as { type?: unknown; payload?: unknown };
  if (type !== 'session_meta' || !payload || typeof payload !== 'object') return false;
  const meta = payload as { source?: unknown; thread_source?: unknown };
  if (meta.thread_source === 'subagent') return true;
  return !!meta.source && typeof meta.source === 'object' && 'subagent' in (meta.source as object);
};

const readFirstLine = async (file: string): Promise<string | null> => {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(FIRST_LINE_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FIRST_LINE_MAX_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf-8');
    const end = text.indexOf('\n');
    return end >= 0 ? text.slice(0, end) : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};

/** True when the transcript's session_meta marks a subagent; false when it marks a root or cannot be read. */
export const transcriptIsSubagent = async (transcriptPath: string): Promise<boolean> => {
  const cached = subagentByTranscript.get(transcriptPath);
  if (cached !== undefined) return cached;
  const firstLine = await readFirstLine(transcriptPath);
  if (firstLine === null) return false; // not written yet, or unreadable: never cached
  const subagent = isSubagentSessionMeta(firstLine);
  if (subagentByTranscript.size >= MAX_CACHED_TRANSCRIPTS) {
    const oldest = subagentByTranscript.keys().next().value;
    if (oldest !== undefined) subagentByTranscript.delete(oldest);
  }
  subagentByTranscript.set(transcriptPath, subagent);
  return subagent;
};

export const isCodexSubagentHook = async (payload: ICodexHookPayload): Promise<boolean> => {
  const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (!transcript) return false;
  const transcriptSession = codexProvider.sessionIdFromJsonlPath(transcript);
  if (transcriptSession && payload.session_id && transcriptSession !== payload.session_id) return true;
  return transcriptIsSubagent(transcript);
};

/** Test seam: forget cached answers. */
export const resetSubagentTranscriptCache = (): void => {
  subagentByTranscript.clear();
};
