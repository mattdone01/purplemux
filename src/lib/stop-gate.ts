import { createLogger } from '@/lib/logger';
import { TURN_TAIL_CHARS } from '@/lib/turn-end';
import {
  STOP_DECISION_DEADLINE_MS,
  decideStop,
  tailMarker,
  type IBlockability,
  type ITurnEndRow,
  type TStopDecision,
  type TUnreportedReason,
} from '@/lib/turn-end-row';
import type { TurnEndsTable } from '@/lib/turn-ends-store';

// The stop gate (F6, folding in F10 steps 1 and 2; design check (2) ruling, 2026-11-10). The Claude Stop hook posts
// its payload; this class decides, within 1 s, whether the stop applies a row, applies the classifier, writes an
// UNREPORTED row, or is held (`{"decision":"block"}`), and it keeps the stop's message so the classifier reads the
// payload rather than racing the transcript flush (F10 step 1). StatusManager applies the decision in its one
// substitution point after `classifyTurnEnd`.

const log = createLogger('stop-gate');

export interface IStopPayload {
  /** `Stop` or `StopFailure` (the script word is `stop` for both). */
  hookEvent: string | null;
  sessionId: string | null;
  /** `last_assistant_message`, whole. */
  message: string | null;
}

export interface IStopGateTab {
  workspaceId: string;
  agentSessionId: string | null | undefined;
  host: string | null | undefined;
  providerId: string;
}

export interface IStopGateDeps {
  now: () => number;
  table: () => TurnEndsTable;
  /** `turn-end.source` is `row` (unset means row). */
  rowsAreSource: () => boolean;
  /** `hook.stop-payload` is on (unset means on). */
  payloadIsTail: () => boolean;
  isCoordinator: (workspaceId: string, tabId: string) => Promise<boolean>;
  isScoped: (workspaceId: string, tabId: string) => Promise<boolean>;
  /** The tab's fixed role (ADR-0040): an evaluator's allow-list cannot run `purplemux`, so it is never blocked. */
  roleOf: (workspaceId: string, tabId: string) => Promise<string | null>;
  /** The seat is between ROTATE and its first message (ADR-0036): never blocked. */
  inRotation: (tabId: string) => boolean;
  /** Registered jobs + armed watches + open provider tasks; null when unknown. */
  openWork: (tabId: string) => Promise<number | null>;
  deadlineMs?: number;
}

interface IPendingBlock {
  sessionId: string;
  turnId: number;
  at: number;
}

const timeout = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    timer.unref?.();
  });

export class StopGate {
  private readonly decisions = new Map<string, TStopDecision>();
  private readonly payloads = new Map<string, { sessionId: string | null; tail: string }>();
  private readonly pending = new Map<string, IPendingBlock>();

  constructor(private readonly deps: IStopGateDeps) {}

  /**
   * Decide one Claude stop. A `block` is recorded (its count and its pending confirmation) and returned for the hook
   * to print; every other decision is kept for `take` when the stop is applied. Never throws: an error lets the stop
   * through on the classifier.
   */
  async decide(tabId: string, tab: IStopGateTab, payload: IStopPayload, replayedAt?: number): Promise<TStopDecision> {
    // A stop of the session is the agent's answer to an earlier hold: that hold reached it.
    this.pending.delete(tabId);
    if (payload.message !== null && payload.sessionId !== null && payload.sessionId === tab.agentSessionId) {
      this.payloads.set(tabId, { sessionId: payload.sessionId, tail: payload.message.slice(-TURN_TAIL_CHARS) });
    } else {
      this.payloads.delete(tabId);
    }
    let decision: TStopDecision;
    let turnId: number | null = null;
    try {
      const decided = await Promise.race([
        this.decideNow(tabId, tab, payload, replayedAt),
        timeout(this.deps.deadlineMs ?? STOP_DECISION_DEADLINE_MS, { decision: { kind: 'classifier', why: 'decision deadline' } as TStopDecision, turnId: null }),
      ]);
      decision = decided.decision;
      turnId = decided.turnId;
    } catch (err) {
      log.warn({ tabId, err: err instanceof Error ? err.message : String(err) }, 'stop decision failed; the classifier applies');
      decision = { kind: 'classifier', why: 'decision error' };
    }
    const sessionId = tab.agentSessionId ?? null;
    if (decision.kind === 'block' && sessionId && turnId !== null) {
      const blocks = this.deps.table().addBlock(sessionId, this.deps.now());
      this.pending.set(tabId, { sessionId, turnId, at: this.deps.now() });
      log.info({ tabId, sessionId, blocks }, 'stop held: no turn-end row');
      this.decisions.delete(tabId);
      this.payloads.delete(tabId);
      return decision;
    }
    // An UNREPORTED row is written against the turn this stop belongs to (review nit 3).
    if (decision.kind === 'unreported' && turnId !== null) decision = { ...decision, turnId };
    this.decisions.set(tabId, decision);
    return decision;
  }

  /**
   * The stop's turn: the session's current one for a live stop; for a replayed stop, the turn that had started when it
   * fired (review nit 3), so neither its row nor its UNREPORTED write lands on a later turn.
   */
  private turnOf(sessionId: string, replayedAt?: number): { turnId: number; blocks: number } | null {
    const table = this.deps.table();
    if (replayedAt === undefined) return table.currentTurn(sessionId);
    const turnId = table.turnAt(sessionId, replayedAt);
    return turnId === null ? null : { turnId, blocks: 0 };
  }

  private async decideNow(tabId: string, tab: IStopGateTab, payload: IStopPayload, replayedAt?: number): Promise<{ decision: TStopDecision; turnId: number | null }> {
    const sessionId = tab.agentSessionId ?? null;
    const turn = sessionId ? this.turnOf(sessionId, replayedAt) : null;
    const row = sessionId && turn ? this.deps.table().unconsumed(sessionId, turn.turnId) : null;
    const tail = this.payloads.get(tabId)?.tail ?? null;
    const blockability: IBlockability = {
      stopFailure: payload.hookEvent === 'StopFailure',
      replayed: replayedAt !== undefined,
      remote: !!tab.host,
      evaluator: (await this.deps.roleOf(tab.workspaceId, tabId)) === 'evaluator',
      provider: tab.providerId,
      openRotation: this.deps.inRotation(tabId),
      coordinator: await this.deps.isCoordinator(tab.workspaceId, tabId),
      scoped: await this.deps.isScoped(tab.workspaceId, tabId),
    };
    // No payload message to read the end line from (a dropped body, a replay without one): nothing is blocked.
    if (tail === null && !row) return { decision: { kind: 'classifier', why: 'no payload message' }, turnId: turn?.turnId ?? null };
    const decision = await decideStop({
      classifierOnly: !this.deps.rowsAreSource(),
      blockability,
      sessionId: turn ? sessionId : null,
      row,
      tailMarker: tailMarker(tail),
      openWork: () => this.deps.openWork(tabId),
      blocks: turn?.blocks ?? 0,
    });
    return { decision, turnId: turn?.turnId ?? null };
  }

  /** The decision for the stop being applied now, taken once. Absent: the classifier (a stop from an older script). */
  take(tabId: string): TStopDecision | null {
    const decision = this.decisions.get(tabId) ?? null;
    this.decisions.delete(tabId);
    return decision;
  }

  /** The stop's own message as the tail (F10 step 1), when the kill switch allows and it belongs to the bound session. */
  takeTail(tabId: string, boundSessionId: string | null | undefined): string | null {
    const payload = this.payloads.get(tabId);
    this.payloads.delete(tabId);
    if (!payload || !this.deps.payloadIsTail() || payload.sessionId !== boundSessionId) return null;
    return payload.tail;
  }

  /** A row the stop applies: used exactly once. False when another stop used it first. */
  consume(row: ITurnEndRow): boolean {
    return this.deps.table().consume(row.sessionId, row.turnId, this.deps.now());
  }

  /**
   * The turn ended with no valid row: one UNREPORTED row for it, with why (F10 AC2), against the stop's own turn
   * (`turnId`, else the current one). It never replaces a row the worker wrote: such a row is consumed instead, so
   * the turn keeps exactly one row and no later stop applies it (review CONCERN).
   */
  writeUnreported(tab: { workspaceId: string; agentSessionId?: string | null }, tabId: string, reason: TUnreportedReason, turnId?: number): void {
    const sessionId = tab.agentSessionId ?? null;
    if (!sessionId) return;
    const turn = turnId ?? this.deps.table().currentTurn(sessionId)?.turnId ?? null;
    if (turn === null) return;
    const at = this.deps.now();
    const written = this.deps.table().putIfAbsent({
      sessionId, turnId: turn, workspaceId: tab.workspaceId, tabId, seatRole: null, story: null, attempt: null,
      verdict: 'UNREPORTED', head: null, gateLog: null, gateVerdict: null, reason: null, source: 'unreported',
      unreportedReason: reason, at, consumedAt: at,
    });
    if (!written && this.deps.table().consume(sessionId, turn, at)) {
      log.info({ tabId, sessionId, turnId: turn, reason }, 'turn end applied without its row; the worker\'s row is kept and marked used');
    }
  }

  /** A live prompt-submit opened a new turn of the session. */
  onPromptSubmit(sessionId: string): void {
    this.deps.table().bumpTurn(sessionId, this.deps.now());
  }

  /**
   * Any hook event of the session after a hold — a tool call, a prompt, a notification, another stop — or a `done`
   * row confirms that the hold reached the agent (review CONCERN: confirmation is positive, never inferred).
   */
  onHookEvent(tabId: string): void {
    this.pending.delete(tabId);
  }

  /**
   * Claude's own `idle_prompt` notification: the session waits for input with no hook event since the hold. That is
   * the one positive sign that the hold never reached it (the hook was killed after the server decided). An empty
   * composer is not that sign: a working tab shows one too (review CONCERN). Returns true when the caller must apply
   * the held stop now, with the decision kept for it: the turn's row when the worker wrote one, else UNREPORTED
   * `block-undelivered`. A row is never overwritten.
   */
  onIdlePrompt(tabId: string): boolean {
    const held = this.pending.get(tabId);
    if (!held) return false;
    this.pending.delete(tabId);
    const row = this.deps.table().unconsumed(held.sessionId, held.turnId);
    this.decisions.set(tabId, row
      ? { kind: 'row', row }
      : { kind: 'unreported', reason: 'block-undelivered', escalation: null, turnId: held.turnId });
    return true;
  }

  forget(tabId: string): void {
    this.decisions.delete(tabId);
    this.payloads.delete(tabId);
    this.pending.delete(tabId);
  }
}
