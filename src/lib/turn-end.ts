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
  | { kind: 'waiting'; openBackgroundTasks: number; liveRegisteredJobs: number; armedWatches: number }
  | { kind: 'ready-for-review'; transcript: boolean };

export interface ITurnEndInput {
  /** `lastAssistantTail` from the provider; undefined when the provider cannot read one. */
  tail: string | null | undefined;
  /** False when no transcript could be read at all (no parser, no path, read error). */
  transcript: boolean;
  openBackgroundTasks: number;
  liveRegisteredJobs: number;
  /** `purplemux watch` records the tab owns: each one wakes it through the inbox (ADR-0015). */
  armedWatches: number;
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
 * (the provider's own tasks, a registered `tab bg` job, or an armed `purplemux
 * watch`) means the harness wakes the worker later, so the stop is WAITING.
 * Otherwise the stop is `ready-for-review` with no end line: the watchdog sends
 * no immediate nudge for it, only the delayed idle nudge (L49).
 */
export const classifyTurnEnd = (input: ITurnEndInput): TTurnEnd => {
  const lines = extractTurnMarker(input.tail);
  if (lines) return { kind: 'turn-marker', lines };
  if (input.openBackgroundTasks > 0 || input.liveRegisteredJobs > 0 || input.armedWatches > 0) {
    return {
      kind: 'waiting',
      openBackgroundTasks: input.openBackgroundTasks,
      liveRegisteredJobs: input.liveRegisteredJobs,
      armedWatches: input.armedWatches,
    };
  }
  return { kind: 'ready-for-review', transcript: input.transcript };
};

/**
 * The quiet window after a stop with no end line and nothing live, before the
 * one `idle-no-end-line` nudge (L49; measured 27 Sep: 22 immediate READY nudges
 * in 2 h 07 min, all on tabs that were only waiting). Fleet config key
 * `watchdog.idle-nudge-minutes` (ADR-0019) overrides it, read by every status poll.
 */
export const IDLE_NUDGE_CONFIG_KEY = 'watchdog.idle-nudge-minutes';
export const IDLE_NUDGE_DEFAULT_MS = 15 * 60 * 1000;
const IDLE_NUDGE_MAX_MINUTES = 24 * 60;

/**
 * The window in ms for a fleet value, or null when the value is absent or not
 * a number of minutes in (0, 1440]. Decimals are allowed (0.05 = 3 s), so an
 * acceptance run can prove the nudge without a 15 min wait.
 */
export const parseIdleNudgeMinutes = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || !/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const minutes = Number(value.trim());
  if (!(minutes > 0) || minutes > IDLE_NUDGE_MAX_MINUTES) return null;
  return Math.round(minutes * 60 * 1000);
};

// Measured 2026-09-26: the longest silence of an open subagent was 10.0 min
// (the foreground Bash limit) over 46 intervals; gates run 20–40 min.
export const AGENT_STALL_WINDOW_MS = 15 * 60 * 1000;
export const SHELL_STALL_BACKSTOP_MS = 90 * 60 * 1000;

/**
 * One `long-wait` nudge per WAITING stretch on a live registered job or an armed
 * watch that outlasts this (review r1 finding 4; story 30 F3's intent): such a
 * tab is never STALLED, so without it a hung gate or a 7-day watch is silent.
 * Fleet config key `watchdog.wait-backstop-hours` overrides it.
 */
export const WAIT_BACKSTOP_CONFIG_KEY = 'watchdog.wait-backstop-hours';
export const WAIT_BACKSTOP_DEFAULT_MS = 4 * 60 * 60 * 1000;
const WAIT_BACKSTOP_MAX_HOURS = 7 * 24;

/** The backstop in ms for a fleet value, or null when it is not hours in (0, 168]. */
export const parseWaitBackstopHours = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || !/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const hours = Number(value.trim());
  if (!(hours > 0) || hours > WAIT_BACKSTOP_MAX_HOURS) return null;
  return Math.round(hours * 60 * 60 * 1000);
};

/**
 * The poll's derived timers (review r1 finding 2: derived from the recorded
 * stop, so a server restart keeps them). The idle nudge is due when the tab's
 * latest event is still the markerless stop it classified, the window has
 * passed since it, and no nudge was sent for that stop yet.
 */
export const idleNudgeDue = (
  turnEnd: { kind: string; at: number; seq?: number; idleNudgeSentSeq?: number } | null | undefined,
  lastEvent: { name: string; seq: number } | null | undefined,
  cliState: string,
  windowMs: number,
  now: number,
): boolean =>
  !!turnEnd && turnEnd.kind === 'ready-for-review' && cliState === 'ready-for-review'
  && turnEnd.seq !== undefined && lastEvent?.name === 'stop' && lastEvent.seq === turnEnd.seq
  && turnEnd.idleNudgeSentSeq !== turnEnd.seq && now - turnEnd.at >= windowMs;

/** The long-wait backstop is due on the same terms for a WAITING stop that is still the latest event. */
export const longWaitDue = (
  turnEnd: { kind: string; at: number; seq?: number; longWaitSentSeq?: number } | null | undefined,
  lastEvent: { name: string; seq: number } | null | undefined,
  cliState: string,
  backstopMs: number,
  now: number,
): boolean =>
  !!turnEnd && turnEnd.kind === 'waiting' && cliState === 'busy'
  && turnEnd.seq !== undefined && lastEvent?.name === 'stop' && lastEvent.seq === turnEnd.seq
  && turnEnd.longWaitSentSeq !== turnEnd.seq && now - turnEnd.at >= backstopMs;

/**
 * A live registered `tab bg` job or an armed `purplemux watch` holds a busy tab
 * that WAITS on it (its latest event is the stop classified `waiting`) off
 * STALLED completely (L49: both "possibly stalled" nudges of 27 Sep fired
 * on such tabs). Each has its own reporter: the liveness manager reports the
 * job's exit, and the watch reports its condition, its failure or its expiry.
 */
export const holdsOffStall = (liveRegisteredJobs: number, armedWatches: number): boolean =>
  liveRegisteredJobs > 0 || armedWatches > 0;

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
