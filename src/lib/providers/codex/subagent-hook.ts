import { codexProvider } from '@/lib/providers/codex';
import type { ICodexHookPayload } from '@/lib/providers/codex/hook-payload';
import { isSubagentSessionMeta, readTranscriptFirstLine } from '@/lib/providers/codex/session-meta-line';

export { isSubagentSessionMeta } from '@/lib/providers/codex/session-meta-line';

/**
 * A Codex native subagent (a `spawn_agent` thread) runs inside its parent's process and pane, so
 * its hooks carry the parent's tmux session and launch generation. Applied to the parent's tab,
 * they re-key it: measured 2026-09-29 on tab-QizeO4, a subagent's hooks set the tab's transcript
 * to the subagent's rollout (the model observation then reported `session-identity-mismatch`)
 * and its tool calls set the tab busy again after the root's Stop, so readiness never cleared
 * and every send to the tab waited.
 *
 * A hook is the subagent's when either:
 * 1. its transcript names another session than its own `session_id` (the case measured: the tab
 *    kept the root's id and took the subagent's transcript); or
 * 2. its transcript's `session_meta` says the session is a subagent, and the hook's session is
 *    not the one the tab is bound to (a subagent that reports its own id). A `SessionStart` with
 *    source `resume` is never dropped by this rule: a resume is a top-level launch.
 *
 * A subagent's hook describes its own session, never the tab's, so none of it applies: not its
 * session metadata, not its work-state events, and not its PermissionRequest (architect ruling
 * 2026-09-29, option C; see hook-dispatch.ts).
 */

/** A transcript's first line never changes: remember the answer per path (bounded). */
const MAX_CACHED_TRANSCRIPTS = 512;
const subagentByTranscript = new Map<string, boolean>();

/** True when the transcript's session_meta marks a subagent; false when it marks a root or cannot be read. */
export const transcriptIsSubagent = async (transcriptPath: string): Promise<boolean> => {
  const cached = subagentByTranscript.get(transcriptPath);
  if (cached !== undefined) return cached;
  const firstLine = await readTranscriptFirstLine(transcriptPath);
  if (firstLine === null) return false; // not written yet, or unreadable: never cached
  try {
    JSON.parse(firstLine);
  } catch {
    return false; // caught mid-write (a last line without its newline): not cached
  }
  const subagent = isSubagentSessionMeta(firstLine);
  if (subagentByTranscript.size >= MAX_CACHED_TRANSCRIPTS) {
    const oldest = subagentByTranscript.keys().next().value;
    if (oldest !== undefined) subagentByTranscript.delete(oldest);
  }
  subagentByTranscript.set(transcriptPath, subagent);
  return subagent;
};

/** True when the hook is a native subagent's, which the dispatcher drops (rules above). */
export const isCodexSubagentHook = async (
  payload: ICodexHookPayload,
  tabSessionId: string | null,
): Promise<boolean> => {
  const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (!transcript) return false;
  const transcriptSession = codexProvider.sessionIdFromJsonlPath(transcript);
  let subagent = !!transcriptSession && !!payload.session_id && transcriptSession !== payload.session_id;
  if (!subagent) {
    const isResume = payload.hook_event_name === 'SessionStart' && payload.source === 'resume';
    const ownSession = payload.session_id ?? transcriptSession;
    subagent = !isResume && ownSession !== tabSessionId && await transcriptIsSubagent(transcript);
  }
  return subagent;
};

/** Test seam: forget cached answers. */
export const resetSubagentTranscriptCache = (): void => {
  subagentByTranscript.clear();
};
