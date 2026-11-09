// Browser-safe: the typed turn end (F6, folding in F10 steps 1 and 2; design check (2) ruling, 2026-11-10).
//
// A worker writes one row per turn with `purplemux done` before it stops. At the stop, the row is the turn's verdict
// and the marker classifier (turn-end.ts) runs beside it in shadow for 7 days, after which F10 step 5 deletes it. A
// worker seat that stops a turn with no row is blocked at most twice, then gets an UNREPORTED row and the classifier's
// verdict. This module holds the rules; the store, the service and the stop route apply them.

import { TURN_MARKER_NAMES, readTurnEnd, type TTurnMarkerName } from '@/lib/turn-end';

export type TTurnVerdict = TTurnMarkerName;
export const TURN_VERDICTS: readonly TTurnVerdict[] = TURN_MARKER_NAMES;
export type TSeatRole = 'builder' | 'reviewer' | 'consult';
export const SEAT_ROLES: readonly TSeatRole[] = ['builder', 'reviewer', 'consult'];

/** A turn end with no valid row: why (ruling (3), (4)). */
export type TUnreportedReason = 'cap' | 'block-undelivered' | `not-blockable:${string}`;

export const REASON_MAX_CHARS = 500;
/** How many times one turn's stop is blocked before it goes through as UNREPORTED (F10 AC2). */
export const MAX_BLOCKS_PER_TURN = 2;
/** The stop route decides within this, or lets the stop through (ruling (1)). */
export const STOP_DECISION_DEADLINE_MS = 1_000;

/** Fleet config kill switches (F10 staged plan, step 1 and 2). Unset means on. */
export const STOP_PAYLOAD_CONFIG_KEY = 'hook.stop-payload';
export const TURN_END_SOURCE_CONFIG_KEY = 'turn-end.source';

export interface ITurnEndRow {
  sessionId: string;
  turnId: number;
  workspaceId: string;
  tabId: string;
  seatRole: TSeatRole | null;
  story: string | null;
  attempt: number | null;
  verdict: TTurnVerdict | 'UNREPORTED';
  head: string | null;
  gateLog: string | null;
  /** The gate's verdict when a gate log was checked (`VALID` or `VALID (…)`). */
  gateVerdict: string | null;
  reason: string | null;
  /** `done`: the worker wrote it; `unreported`: the server wrote it at a turn end with no valid row. */
  source: 'done' | 'unreported';
  unreportedReason: TUnreportedReason | null;
  at: number;
  consumedAt: number | null;
}

/** C0 controls, DEL and the Unicode line and paragraph separators: none of them survives in a one-line reason. */
const isLineBreaking = (code: number): boolean => code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;

const MARKER_WORD = new RegExp(`(?:^|[^A-Za-z0-9_-])(${TURN_MARKER_NAMES.join('|')}):`);

/**
 * `--reason` as one line of at most 500 characters (ruling (5)): whitespace and control characters collapse to one
 * space. A reason that holds a marker word (`DONE:` …) is refused: the synthesized end line would carry two markers,
 * the D28 shape the classifier refuses.
 */
export const cleanReason = (raw: unknown): { ok: true; reason: string | null } | { ok: false; error: string } => {
  if (raw === undefined || raw === null) return { ok: true, reason: null };
  if (typeof raw !== 'string') return { ok: false, error: `reason must be text, got ${typeof raw}` };
  const one = Array.from(raw, (ch) => (isLineBreaking(ch.codePointAt(0)!) ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim();
  if (!one) return { ok: true, reason: null };
  if (one.length > REASON_MAX_CHARS) return { ok: false, error: `reason is ${one.length} characters after cleaning; at most ${REASON_MAX_CHARS}` };
  const marker = MARKER_WORD.exec(one);
  if (marker) return { ok: false, error: `reason holds the turn marker ${marker[1]}:; the verdict is --verdict, never text in the reason` };
  return { ok: true, reason: one };
};

/** The seat a scope declares, or `builder` when it names a story and declares none (ruling (8)). */
export const seatRoleOf = (scope: { story: string | null; seat?: TSeatRole | null } | null): TSeatRole | null =>
  scope ? scope.seat ?? (scope.story ? 'builder' : null) : null;

/**
 * The end line the row stands for, starting with its marker so every later step (the nudge, reportOn, the window's
 * BLOCKED/NEEDS-DECISION exemption, the NEEDS-DECISION item) reads it as an end line (ruling (5)).
 */
export const synthesizeLine = (row: Pick<ITurnEndRow, 'verdict' | 'reason' | 'story' | 'head' | 'gateVerdict'>): string => {
  const marker = row.verdict === 'UNREPORTED' ? 'UNREPORTED' : row.verdict;
  const facts = [
    row.story ? `story ${row.story}` : null,
    row.head ? `head ${row.head.slice(0, 12)}` : null,
    row.gateVerdict ? `gate ${row.gateVerdict}` : null,
  ].filter((fact): fact is string => fact !== null);
  const reason = row.reason ?? (row.verdict === 'DONE' ? 'done' : row.verdict.toLowerCase());
  return `${marker}: ${reason}${facts.length ? ` (${facts.join(', ')})` : ''}`;
};

const ESCALATION: Readonly<Record<string, number>> = { 'NEEDS-DECISION': 2, BLOCKED: 1 };

/** The payload tail's end-line marker, or null (no tail, no marker, or a refused two-marker line). */
export const tailMarker = (tail: string | null | undefined): TTurnMarkerName | null => {
  const read = readTurnEnd(tail);
  if (read?.kind !== 'marker') return null;
  const last = read.lines.at(-1) ?? '';
  return TURN_MARKER_NAMES.find((name) => last.startsWith(`${name}:`)) ?? null;
};

/** A row that a BLOCKED or NEEDS-DECISION tail contradicts: the tail escalates beyond the row (ruling (6)). */
export const escalates = (rowVerdict: TTurnVerdict, tail: TTurnMarkerName | null): boolean =>
  tail !== null && (ESCALATION[tail] ?? 0) > (ESCALATION[rowVerdict] ?? 0);

/** Why a turn end can never be blocked, or null (ruling (4)). */
export interface IBlockability {
  stopFailure: boolean;
  replayed: boolean;
  remote: boolean;
  evaluator: boolean;
  provider: string;
  openRotation: boolean;
  coordinator: boolean;
  scoped: boolean;
}

export const notBlockable = (b: IBlockability): string | null => {
  if (b.stopFailure) return 'stop-failure';
  if (b.replayed) return 'replayed';
  if (b.remote) return 'remote';
  if (b.evaluator) return 'evaluator';
  if (b.provider !== 'claude') return `provider-${b.provider}`;
  if (b.openRotation) return 'rotation';
  if (b.coordinator) return 'coordinator';
  if (!b.scoped) return 'unscoped';
  return null;
};

export type TStopDecision =
  /** The stop applies as before this story: the classifier's lines. */
  | { kind: 'classifier'; why: string }
  /** The row is the turn's verdict. */
  | { kind: 'row'; row: ITurnEndRow }
  /** The stop is held: Claude continues the turn with `reason` (the block budget is spent by one). */
  | { kind: 'block'; reason: string }
  /** No valid row: an UNREPORTED row is written, and the verdict is the classifier's (or the escalating one). */
  | { kind: 'unreported'; reason: TUnreportedReason; escalation: TTurnMarkerName | null; turnId?: number };

export interface IStopDecisionInput {
  /** `turn-end.source=classifier`: the kill switch. */
  classifierOnly: boolean;
  blockability: IBlockability;
  /** The tab's bound agent session; null when none is bound. */
  sessionId: string | null;
  /** The unconsumed row of the current turn, or null. */
  row: ITurnEndRow | null;
  /** The payload tail's marker (the classifier's own read of the stop's message). */
  tailMarker: TTurnMarkerName | null;
  /**
   * Open work that makes a markerless stop a WAITING stop: registered jobs + armed watches + open provider tasks.
   * null when it could not be read by the deadline. Read only when the tail has no marker.
   */
  openWork: () => Promise<number | null>;
  blocks: number;
}

const BLOCK_HELP = 'purplemux done --verdict DONE|BLOCKED|NEEDS-DECISION|READY-TO-MERGE|CHECKPOINTED [--reason TEXT] [--gate-log ABS]';

/**
 * One stop's decision (ruling (1), (4), (6)). Only a turn end is ever blocked: a markerless stop with open work is a
 * WAITING stop and needs no row. An unknown background count blocks nothing.
 */
export const decideStop = async (input: IStopDecisionInput): Promise<TStopDecision> => {
  if (input.classifierOnly) return { kind: 'classifier', why: 'turn-end.source=classifier' };
  if (input.sessionId === null) return { kind: 'classifier', why: 'no bound agent session' };
  const never = notBlockable(input.blockability);
  if (input.row && !(input.row.verdict !== 'UNREPORTED' && escalates(input.row.verdict, input.tailMarker))) {
    return { kind: 'row', row: input.row };
  }
  if (input.tailMarker === null && input.row === null) {
    const open = await input.openWork();
    if (open === null) return { kind: 'classifier', why: 'open work unknown by the deadline' };
    if (open > 0) return { kind: 'classifier', why: 'waiting on open work' };
  }
  const mismatch = input.row !== null;
  if (never !== null) {
    if (never === 'unscoped' || never === 'coordinator') return { kind: 'classifier', why: never };
    return { kind: 'unreported', reason: `not-blockable:${never}`, escalation: mismatch ? input.tailMarker : null };
  }
  if (input.blocks < MAX_BLOCKS_PER_TURN) {
    const missing = mismatch
      ? `your turn-end row says ${input.row!.verdict}, but your last line ends ${input.tailMarker}: write the row again with --verdict ${input.tailMarker} (or end with the row's verdict)`
      : 'no turn-end row for this turn';
    return { kind: 'block', reason: `Run ${BLOCK_HELP} before you end the turn; missing: ${missing} (stop ${input.blocks + 1} of ${MAX_BLOCKS_PER_TURN} held).` };
  }
  return { kind: 'unreported', reason: 'cap', escalation: mismatch ? input.tailMarker : null };
};
