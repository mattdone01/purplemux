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

/** A held stop not confirmed by a later hook event within this long is checked against the pane (ruling (3)). */
export const BLOCK_CONFIRM_MS = 15_000;

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
  async decide(tabId: string, tab: IStopGateTab, payload: IStopPayload, replayed: boolean): Promise<TStopDecision> {
    if (payload.message !== null && payload.sessionId !== null && payload.sessionId === tab.agentSessionId) {
      this.payloads.set(tabId, { sessionId: payload.sessionId, tail: payload.message.slice(-TURN_TAIL_CHARS) });
    } else {
      this.payloads.delete(tabId);
    }
    let decision: TStopDecision;
    try {
      decision = await Promise.race([
        this.decideNow(tabId, tab, payload, replayed),
        timeout<TStopDecision>(this.deps.deadlineMs ?? STOP_DECISION_DEADLINE_MS, { kind: 'classifier', why: 'decision deadline' }),
      ]);
    } catch (err) {
      log.warn({ tabId, err: err instanceof Error ? err.message : String(err) }, 'stop decision failed; the classifier applies');
      decision = { kind: 'classifier', why: 'decision error' };
    }
    const sessionId = tab.agentSessionId ?? null;
    if (decision.kind === 'block' && sessionId) {
      const blocks = this.deps.table().addBlock(sessionId, this.deps.now());
      this.pending.set(tabId, { sessionId, at: this.deps.now() });
      log.info({ tabId, sessionId, blocks }, 'stop held: no turn-end row');
      this.decisions.delete(tabId);
      this.payloads.delete(tabId);
      return decision;
    }
    this.decisions.set(tabId, decision);
    return decision;
  }

  private async decideNow(tabId: string, tab: IStopGateTab, payload: IStopPayload, replayed: boolean): Promise<TStopDecision> {
    const sessionId = tab.agentSessionId ?? null;
    const turn = sessionId ? this.deps.table().currentTurn(sessionId) : null;
    const row = sessionId && turn ? this.deps.table().unconsumed(sessionId, turn.turnId) : null;
    const tail = this.payloads.get(tabId)?.tail ?? null;
    const blockability: IBlockability = {
      stopFailure: payload.hookEvent === 'StopFailure',
      replayed,
      remote: !!tab.host,
      evaluator: (await this.deps.roleOf(tab.workspaceId, tabId)) === 'evaluator',
      provider: tab.providerId,
      openRotation: this.deps.inRotation(tabId),
      coordinator: await this.deps.isCoordinator(tab.workspaceId, tabId),
      scoped: await this.deps.isScoped(tab.workspaceId, tabId),
    };
    // No payload message to read the end line from (a dropped body, a replay without one): nothing is blocked.
    if (tail === null && !row) return { kind: 'classifier', why: 'no payload message' };
    return decideStop({
      classifierOnly: !this.deps.rowsAreSource(),
      blockability,
      sessionId: turn ? sessionId : null,
      row,
      tailMarker: tailMarker(tail),
      openWork: () => this.deps.openWork(tabId),
      blocks: turn?.blocks ?? 0,
    });
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

  /** The turn ended with no valid row: one UNREPORTED row for it, with why (F10 AC2). */
  writeUnreported(tab: { workspaceId: string; agentSessionId?: string | null }, tabId: string, reason: TUnreportedReason): void {
    const sessionId = tab.agentSessionId ?? null;
    if (!sessionId) return;
    const turn = this.deps.table().currentTurn(sessionId);
    if (!turn) return;
    const at = this.deps.now();
    this.deps.table().put({
      sessionId, turnId: turn.turnId, workspaceId: tab.workspaceId, tabId, seatRole: null, story: null, attempt: null,
      verdict: 'UNREPORTED', head: null, gateLog: null, gateVerdict: null, reason: null, source: 'unreported',
      unreportedReason: reason, at, consumedAt: at,
    });
  }

  /** A live prompt-submit opened a new turn of the session. */
  onPromptSubmit(sessionId: string): void {
    this.deps.table().bumpTurn(sessionId, this.deps.now());
  }

  /** Any hook event of the tab confirms that a held stop reached Claude (ruling (3)). */
  onHookEvent(tabId: string): void {
    this.pending.delete(tabId);
  }

  /** Held stops with no hook event since for longer than BLOCK_CONFIRM_MS: the caller checks each pane. */
  unconfirmed(now: number): string[] {
    return [...this.pending].filter(([, block]) => now - block.at >= BLOCK_CONFIRM_MS).map(([tabId]) => tabId);
  }

  /** The pane shows the agent at its prompt with no event since the hold: the block never arrived (ruling (3)). */
  undelivered(tabId: string): void {
    this.pending.delete(tabId);
    this.decisions.set(tabId, { kind: 'unreported', reason: 'block-undelivered', escalation: null });
  }

  forget(tabId: string): void {
    this.decisions.delete(tabId);
    this.payloads.delete(tabId);
    this.pending.delete(tabId);
  }
}
