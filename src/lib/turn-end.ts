// Browser-safe: the classifier the watchdog runs on every agent `stop`, and the
// stall rule for a tab that waits on background work (ADR-0018).

import type { IOpenBackgroundTaskKinds } from '@/lib/providers/types';

export const TURN_TAIL_CHARS = 600;
export const TURN_MARKERS = ['DONE:', 'BLOCKED:', 'NEEDS-DECISION:', 'READY-TO-MERGE:'] as const;
const READY_TO_MERGE = 'READY-TO-MERGE:';
const MAX_MARKER_LINE_CHARS = 300;
const MAX_READY_TO_MERGE_LINES = 5;

export type TTurnEnd =
  | { kind: 'turn-marker'; lines: string[] }
  | { kind: 'waiting'; openBackgroundTasks: number; liveRegisteredJobs: number }
  | { kind: 'ready-for-review'; transcript: boolean };

export interface ITurnEndInput {
  /** `lastAssistantTail` from the provider; undefined when the provider cannot read one. */
  tail: string | null | undefined;
  /** False when no transcript could be read at all (no parser, no path, read error). */
  transcript: boolean;
  openBackgroundTasks: number;
  liveRegisteredJobs: number;
}

// Markdown emphasis or a quote around the marker does not hide it.
const bare = (line: string): string => line.trim().replace(/^[>*_`\s]+/, '').replace(/[*_`\s]+$/, '');

const clip = (line: string): string =>
  line.length > MAX_MARKER_LINE_CHARS ? `${line.slice(0, MAX_MARKER_LINE_CHARS)}…` : line;

/**
 * The marker lines a turn ended on, or null. The LAST non-empty line must start
 * with a marker; `READY-TO-MERGE:` lines directly above it ride along (one per
 * PR, then `DONE:` — worker contract rule 10), at most five.
 */
export const extractTurnMarker = (tail: string | null | undefined): string[] | null => {
  if (!tail) return null;
  const lines = tail.split('\n').map(bare).filter(Boolean);
  const last = lines.at(-1);
  if (!last || !TURN_MARKERS.some((marker) => last.startsWith(marker))) return null;
  const above: string[] = [];
  for (let i = lines.length - 2; i >= 0 && above.length < MAX_READY_TO_MERGE_LINES; i--) {
    if (!lines[i].startsWith(READY_TO_MERGE)) break;
    above.unshift(lines[i]);
  }
  if (last.startsWith(READY_TO_MERGE) && above.length === MAX_READY_TO_MERGE_LINES) above.shift();
  return [...above, last].map(clip);
};

/**
 * A marker wins: the worker said what it is. Without one, open background work
 * (the provider's own tasks or a registered `tab bg` job) means the harness
 * wakes the worker later, so the stop is WAITING. Otherwise today's review.
 */
export const classifyTurnEnd = (input: ITurnEndInput): TTurnEnd => {
  const lines = extractTurnMarker(input.tail);
  if (lines) return { kind: 'turn-marker', lines };
  if (input.openBackgroundTasks > 0 || input.liveRegisteredJobs > 0) {
    return { kind: 'waiting', openBackgroundTasks: input.openBackgroundTasks, liveRegisteredJobs: input.liveRegisteredJobs };
  }
  return { kind: 'ready-for-review', transcript: input.transcript };
};

// Measured 2026-09-26: the longest silence of an open subagent was 10.0 min
// (the foreground Bash limit) over 46 intervals; gates run 20–40 min.
export const AGENT_STALL_WINDOW_MS = 15 * 60 * 1000;
export const SHELL_STALL_BACKSTOP_MS = 90 * 60 * 1000;

/**
 * Whether a busy tab that waits on its own background work is stalled, or null
 * when nothing is open (the caller keeps its default rule). Silence means
 * something different per kind: a working subagent writes its transcript all
 * the time; a gate waiter writes nothing until it exits; a Monitor ends itself
 * at its timeout. `activityAt` is the newest sign of life of the tab.
 */
export const isBackgroundWaitStalled = (
  kinds: IOpenBackgroundTaskKinds | undefined,
  activityAt: number | null,
  now: number,
): boolean | null => {
  if (!kinds || kinds.shell + kinds.agent + kinds.monitor === 0) return null;
  const silentMs = activityAt === null ? Infinity : now - activityAt;
  if (kinds.agent > 0) return silentMs >= AGENT_STALL_WINDOW_MS;
  if (kinds.shell > 0) return silentMs >= SHELL_STALL_BACKSTOP_MS;
  return false;
};
