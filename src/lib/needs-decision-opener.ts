import { createHash } from 'crypto';
import { createLogger } from '@/lib/logger';
import { isMissionControlError } from '@/lib/mission-control-errors';
import type {
  IMissionItemOpener, IMissionNeedsDecisionLineInput, IMissionNeedsDecisionTabItem, IMissionOpenRunBinding,
} from '@/lib/mission-control-store';
import { NEEDS_DECISION_EVENT_PREFIX } from '@/lib/mission-control-validation';
import {
  buildNeedsDecisionQuestion, isNeedsDecisionLine, needsDecisionAsks, needsDecisionIsNew, withoutNewMark,
} from '@/lib/needs-decision';

// The server's NEEDS-DECISION producer (ADR-0041; story 14 AC 4). The item opens human-visible in one
// event: `attention.opened` carrying the workspace orchestrator's human review, on the orchestrator's
// run, through the same validator and authority checks an agent's event meets. Its opener is the tab.

const log = createLogger('needs-decision');

/** One item id per line key for 24 h (story 36 review r1, finding 1); in memory, and the store answers a miss (#521). */
export const NEEDS_DECISION_ID_WINDOW_MS = 24 * 60 * 60_000;
const NEEDS_DECISION_ID_MEMORY = 2_000;
const g = globalThis as unknown as { __ptNeedsDecisionItemIds?: Map<string, { itemId: string; at: number }> };
const rememberedIds = (): Map<string, { itemId: string; at: number }> => {
  if (!g.__ptNeedsDecisionItemIds) g.__ptNeedsDecisionItemIds = new Map();
  return g.__ptNeedsDecisionItemIds;
};
/** The line key's id from now; the newest entry goes last, and the oldest leaves past the cap. */
const rememberId = (lineKey: string, itemId: string, at: number): void => {
  const ids = rememberedIds();
  ids.delete(lineKey);
  ids.set(lineKey, { itemId, at });
  while (ids.size > NEEDS_DECISION_ID_MEMORY) ids.delete(ids.keys().next().value!);
};

export interface INeedsDecisionStop {
  workspaceId: string;
  tabId: string;
  tabName: string;
  /** The turn's last line, unclipped where the tail holds all of it. */
  line: string;
  /** False when the line's start may be missing: the question is then a text question (review r1, R2). */
  lineComplete?: boolean;
  /** The stop's sequence number on the tab: one stop opens at most one item. */
  stopSeq: number;
  /** When the stop happened: the seq restarts at 0 with the server, the time does not (confirm D1). */
  stopAt: number;
  /** When the turn began: an item the tab opened since then means it already asked. */
  turnStartedAt: number;
  /** Why a tab that should not ask the owner does (D28 review r1, 1: `reports-to target unavailable: …`); in the item. */
  fallbackReason?: string;
}

/** A NEEDS-DECISION stop that opened no item: the fallback of ADR-0041 §2 takes over. */
export type TNeedsDecisionNoItemReason = 'no-orchestrator' | 'no-orchestrator-run' | 'refused' | 'error';

/** The owner's answer to an `nd-` item, as the asker's re-delivery notice states it (story PM-2, D51). */
export interface INeedsDecisionAnswerView {
  answeredAt: number;
  optionIds: string[];
  optionLabels: string[];
  text: string;
  /** The answer's delivery row: `state` null when none is recorded. */
  delivery: { state: string | null; reason: string | null; tabId: string | null };
}

export type TNeedsDecisionOutcome =
  | { opened: true; itemId: string; runId: string }
  /** `openIds`: every open item of the tab, when more than one is open and the line revised none (story PM-2). */
  | { opened: false; reason: 'already-open'; itemId: string; openIds?: string[] }
  | { opened: false; reason: 'asked-this-turn'; itemId: string }
  /** The tab's one open item now asks this line (D50): `replaced` is the `decision` it asked before. */
  | { opened: false; reason: 'revised'; itemId: string; revision: number; replaced: string }
  /**
   * The owner already answered the tab's item (D51): no item opens; the answer is re-delivered to the asker. `differs`:
   * the line is not one the item ever took (a reword before the ack); `question` is the answered item's decision.
   */
  | { opened: false; reason: 'answered'; itemId: string; answer: INeedsDecisionAnswerView; differs: boolean; question: string }
  | { opened: false; reason: 'not-needs-decision' }
  /** The line asks nothing: no `?` after the marker (D28). No item, no push, no orchestrator note to open one. */
  | { opened: false; reason: 'no-question' }
  /** `itemId` is the id the server would have used: the orchestrator is told to open that one (confirm C4, F1 (i)). */
  | { opened: false; reason: TNeedsDecisionNoItemReason; itemId: string; detail?: string };

export interface INeedsDecisionDeps {
  now: () => number;
  orchestratorTabId: (workspaceId: string) => Promise<string | null>;
  openRuns: (workspaceId: string) => IMissionOpenRunBinding[];
  itemsOpenedByTab: (workspaceId: string, tabId: string, since: number) => string[];
  /** Still-open items (candidate or open) whose id starts with the prefix, whoever opened them (confirm C3). */
  openItemsWithIdPrefix: (workspaceId: string, prefix: string) => string[];
  /** The item's state, or null when no item has that id. */
  itemState: (itemId: string) => string | null;
  /** The tab's `nd-` items, oldest first: open ones, and the ones changed since `since` (story PM-2). */
  itemsOfTab: (workspaceId: string, tabId: string, lineKey: string, since: number) => IMissionNeedsDecisionTabItem[];
  /** Record a line key for an item outside an event: a reservation for a handed-out id, or a race record (story PM-2). */
  recordLine: (workspaceId: string, tabId: string, lineKey: string, itemId: string, markedNew: boolean) => void;
  apply: (
    workspaceId: string, events: unknown[], opener: IMissionItemOpener,
    options: { serverPrefix: string; ndLines?: ReadonlyMap<string, IMissionNeedsDecisionLineInput> },
  ) => Promise<unknown>;
}

const digest = (...parts: Array<string | number>): string =>
  createHash('sha256').update(parts.join('\0')).digest('hex');

// An item id the asker quotes in its repeat, bare or in brackets, is not part of the question (review r1, finding 3).
const QUOTED_ITEM_ID = /[([]?\bnd-[0-9a-f]{32}\b[)\]]?/g;

// `[new]` is not part of the question either (story PM-2): `[new] Q` and `Q` share one key.
const normalized = (line: string): string => withoutNewMark(line.replace(QUOTED_ITEM_ID, ' ').trim()).trim().replace(/\s+/g, ' ');

export const needsDecisionLineKey = (workspaceId: string, tabId: string, line: string): string =>
  digest(workspaceId, tabId, normalized(line)).slice(0, 16);

/**
 * `nd-<16 hex of the tab and its normalized line><16 hex of this stop>`: the first half names the question, so a
 * repeat of the line finds the open item of the same question (review r1, R1); the second half takes the stop's
 * time as well as its seq, which restarts with the server (confirm D1).
 */
export const needsDecisionItemId = (
  stop: Pick<INeedsDecisionStop, 'workspaceId' | 'tabId' | 'line' | 'stopSeq' | 'stopAt'>,
): { itemId: string; lineKey: string } => {
  const lineKey = needsDecisionLineKey(stop.workspaceId, stop.tabId, stop.line);
  return { lineKey, itemId: `nd-${lineKey}${digest(lineKey, stop.stopAt, stop.stopSeq).slice(0, 16)}` };
};

/**
 * The line's id for this stop (review r1, finding 1): the id first minted for the line key within 24 h, unless an item
 * of that id has closed (answered, resolved, cancelled: the same line then asks anew). Where the memory has no such id
 * (a restart empties it, #521), the newest still-open `nd-<lineKey>` item in the store gives it; with none, this
 * stop's own id. The id is remembered, so every not-opened outcome names the id a later open takes, and a second open
 * meets the same id. `closed` reports an item of that id that exists and is no longer open; `openIds` lists the open
 * items with an id prefix, oldest first. A failing read counts as not closed, or as no open item.
 */
export const stableNeedsDecisionItemId = (
  stop: Pick<INeedsDecisionStop, 'workspaceId' | 'tabId' | 'line' | 'stopSeq' | 'stopAt'>,
  now: number,
  closed: (itemId: string) => boolean,
  openIds: (prefix: string) => readonly string[] = () => [],
): { itemId: string; lineKey: string } => {
  const fresh = needsDecisionItemId(stop);
  const held = rememberedIds().get(fresh.lineKey);
  if (held && now - held.at < NEEDS_DECISION_ID_WINDOW_MS) {
    let isClosed = false;
    try {
      isClosed = closed(held.itemId);
    } catch {
      isClosed = false;
    }
    if (!isClosed) return { itemId: held.itemId, lineKey: fresh.lineKey };
  }
  let open: string | undefined;
  try {
    open = openIds(`nd-${fresh.lineKey}`).at(-1);
  } catch {
    open = undefined;
  }
  const itemId = open ?? fresh.itemId;
  rememberId(fresh.lineKey, itemId, now);
  return { itemId, lineKey: fresh.lineKey };
};

const OPEN_STATES = new Set(['candidate', 'open']);

/**
 * How long after the owner's answer a line of the tab still counts as a repeat of the answered question (story PM-2,
 * D51): 24 h, from the answer's time. Measured on the live store 2026-11-07: the D51 repeat came 22.2 min after the
 * answer, after the ack; the shortest gap to a different question was 0.6 min. It covers `answered` and `resolved`.
 */
export const NEEDS_DECISION_ANSWER_WINDOW_MS = NEEDS_DECISION_ID_WINDOW_MS;

const ANSWERED_STATES = new Set(['answered', 'resolved']);

/** Never throws: a failing dependency is the `error` outcome, so the stop always takes a path (confirm D2, C4). */
export const openNeedsDecisionItem = async (deps: INeedsDecisionDeps, stop: INeedsDecisionStop): Promise<TNeedsDecisionOutcome> => {
  if (!isNeedsDecisionLine(stop.line)) return { opened: false, reason: 'not-needs-decision' };
  if (!needsDecisionAsks(stop.line)) {
    log.warn({ workspaceId: stop.workspaceId, tabId: stop.tabId, line: stop.line }, 'NEEDS-DECISION refused: the line holds no question mark, so no item opens');
    return { opened: false, reason: 'no-question' };
  }
  const { itemId, lineKey } = stableNeedsDecisionItemId(stop, deps.now(), (id) => {
    const state = deps.itemState(id);
    return state !== null && !OPEN_STATES.has(state);
  }, (prefix) => deps.openItemsWithIdPrefix(stop.workspaceId, prefix));
  const marked = needsDecisionIsNew(stop.line);
  let outcome: TNeedsDecisionOutcome;
  try {
    outcome = await decide(deps, stop, itemId, lineKey, marked);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ workspaceId: stop.workspaceId, tabId: stop.tabId, itemId }, `NEEDS-DECISION opener failed: ${detail}`);
    outcome = { opened: false, reason: 'error', itemId, detail };
  }
  // An id handed to the orchestrator (or named to the asker) counts as the tab's once an item of it exists (consult 5).
  if (!outcome.opened && ['no-orchestrator', 'no-orchestrator-run', 'refused', 'error'].includes(outcome.reason) && 'itemId' in outcome) {
    try {
      deps.recordLine(stop.workspaceId, stop.tabId, lineKey, outcome.itemId, marked);
    } catch (err) {
      log.warn({ workspaceId: stop.workspaceId, tabId: stop.tabId }, `NEEDS-DECISION reservation not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return outcome;
};

const answeredInWindow = (item: IMissionNeedsDecisionTabItem, now: number): boolean =>
  ANSWERED_STATES.has(item.state) && item.answer !== null && now - item.answer.createdAt < NEEDS_DECISION_ANSWER_WINDOW_MS;

const answeredOutcome = (item: IMissionNeedsDecisionTabItem, differs: boolean): TNeedsDecisionOutcome => ({
  opened: false,
  reason: 'answered',
  itemId: item.id,
  differs,
  question: item.decision,
  answer: {
    answeredAt: item.answer!.createdAt,
    optionIds: item.answer!.optionIds,
    optionLabels: item.answer!.optionLabels,
    text: item.answer!.text,
    delivery: { state: item.answer!.delivery?.state ?? null, reason: item.answer!.delivery?.reason ?? null, tabId: item.answer!.delivery?.tabId ?? null },
  },
});

/**
 * The decision table of story PM-2 (design check, with consult changes 1-6). The first row that holds wins:
 * 1. an OPEN item of the tab that ever took this line key: `already-open`;
 * 2. an item answered inside the answer window that ever took this key, whatever its ack and even with `[new]`: `answered`;
 * then `asked-this-turn` (the tab's own item, never the server's `nd-` item of the previous stop);
 * a line without an effective `[new]` (one that a `[new]`-opened open item does not void):
 * 3. exactly one OPEN item of the tab, in state `open`: revise it; more than one open, or a candidate: `already-open`;
 * 4. an answered item inside the window whose delivery is not acknowledged: `answered` (the line differs);
 * 5. otherwise today's open path.
 */
const decide = async (
  deps: INeedsDecisionDeps, stop: INeedsDecisionStop, itemId: string, lineKey: string, marked: boolean,
): Promise<TNeedsDecisionOutcome> => {
  const now = deps.now();
  const mine = deps.itemsOfTab(stop.workspaceId, stop.tabId, lineKey, now - NEEDS_DECISION_ANSWER_WINDOW_MS);
  const open = mine.filter((item) => OPEN_STATES.has(item.state));
  const exactOpen = open.filter((item) => item.keys.includes(lineKey)).at(-1);
  if (exactOpen) return { opened: false, reason: 'already-open', itemId: exactOpen.id };
  const exactAnswered = mine.filter((item) => answeredInWindow(item, now) && item.keys.includes(lineKey)).at(-1);
  if (exactAnswered) return answeredOutcome(exactAnswered, false);
  const serverOwn = new Set(mine.filter((item) => item.serverOpened).map((item) => item.id));
  const asked = deps.itemsOpenedByTab(stop.workspaceId, stop.tabId, stop.turnStartedAt).filter((id) => !serverOwn.has(id));
  if (asked.length) return { opened: false, reason: 'asked-this-turn', itemId: asked[0] };
  const asksNew = marked && !open.some((item) => item.markedNew);
  if (!asksNew) {
    if (open.length === 1 && open[0].state === 'open') return revise(deps, stop, open[0], lineKey);
    if (open.length) return { opened: false, reason: 'already-open', itemId: open.at(-1)!.id, ...(open.length > 1 ? { openIds: open.map((item) => item.id) } : {}) };
    const unacked = mine.filter((item) => item.state === 'answered' && answeredInWindow(item, now) && item.answer?.delivery?.state !== 'acknowledged').at(-1);
    if (unacked) return answeredOutcome(unacked, true);
  }
  return openItem(deps, stop, itemId, lineKey, asksNew);
};

/** The orchestrator's human review of a server-made NEEDS-DECISION item: one text for the open and each revision. */
const humanReviewOf = (stop: INeedsDecisionStop, orchestratorTabId: string) => {
  const name = stop.tabName || stop.tabId;
  return {
    humanNeed: 'decision',
    humanReason: stop.fallbackReason
      ? `${name} ended its turn with NEEDS-DECISION and no tab can take it (${stop.fallbackReason}): the owner decides it.`
      : `${name} ended its turn with NEEDS-DECISION: only the owner decides it.`,
    handling: 'Opened by the purplemux server from the end line (ADR-0041); the orchestrator relays the answer.',
    reviewerTabId: orchestratorTabId,
  };
};

const questionOf = (stop: INeedsDecisionStop) => buildNeedsDecisionQuestion({
  line: stop.line, complete: stop.lineComplete, workspaceId: stop.workspaceId, tabId: stop.tabId, tabName: stop.tabName, fallbackReason: stop.fallbackReason,
});

/**
 * Revise the tab's one open item to this line (D50): `attention.updated` on the item's own run with the orchestrator's
 * review again, and the line key recorded in the same transaction. A failed revise never opens a second item: the
 * item's state after the failure decides (consult change 6).
 */
const revise = async (
  deps: INeedsDecisionDeps, stop: INeedsDecisionStop, item: IMissionNeedsDecisionTabItem, lineKey: string,
): Promise<TNeedsDecisionOutcome> => {
  const orchestratorTabId = await deps.orchestratorTabId(stop.workspaceId);
  const run = deps.openRuns(stop.workspaceId).find((candidate) => candidate.runId === item.runId);
  let failure: string;
  if (!orchestratorTabId) failure = 'no orchestrator';
  else if (!run) failure = `the item's run ${item.runId} is not open and bound`;
  else {
    const revision = item.revision + 1;
    const eventId = `${NEEDS_DECISION_EVENT_PREFIX}${item.id.slice(3)}:r${revision}`;
    const event = {
      eventId,
      schemaVersion: 1,
      type: 'attention.updated',
      workspaceId: stop.workspaceId,
      runId: item.runId,
      expectedRevision: item.revision,
      producerAt: deps.now(),
      bindingGeneration: run.binding.generation,
      payload: { itemId: item.id, ...questionOf(stop), humanReview: humanReviewOf(stop, orchestratorTabId) },
    };
    try {
      await deps.apply(stop.workspaceId, [event], { tabId: stop.tabId, identity: 'hook' }, {
        serverPrefix: NEEDS_DECISION_EVENT_PREFIX,
        ndLines: new Map([[eventId, { tabId: stop.tabId, lineKey, markedNew: false }]]),
      });
      log.info({ workspaceId: stop.workspaceId, tabId: stop.tabId, itemId: item.id, revision }, 'NEEDS-DECISION revised the tab\'s open Mission Control item');
      return { opened: false, reason: 'revised', itemId: item.id, revision, replaced: item.decision };
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
  }
  log.warn({ workspaceId: stop.workspaceId, tabId: stop.tabId, itemId: item.id }, `NEEDS-DECISION revise failed: ${failure}`);
  const state = deps.itemState(item.id);
  if (state !== null && OPEN_STATES.has(state)) return { opened: false, reason: 'already-open', itemId: item.id };
  if (state !== null && ANSWERED_STATES.has(state)) {
    // Answered in the race: the line is the item's now, so a repeat after the ack stays a repeat.
    deps.recordLine(stop.workspaceId, stop.tabId, lineKey, item.id, false);
    const now = deps.now();
    const answered = deps.itemsOfTab(stop.workspaceId, stop.tabId, lineKey, now - NEEDS_DECISION_ANSWER_WINDOW_MS)
      .find((candidate) => candidate.id === item.id);
    if (answered?.answer) return answeredOutcome(answered, true);
  }
  // Cancelled (or gone): the line asks anew under its own id.
  const { itemId } = needsDecisionItemId(stop);
  return openItem(deps, stop, itemId, lineKey, false);
};

const openItem = async (
  deps: INeedsDecisionDeps, stop: INeedsDecisionStop, itemId: string, lineKey: string, markedNew: boolean,
): Promise<TNeedsDecisionOutcome> => {
  // The same question, still open from any opener: the worker's repeat, or the orchestrator's item from the note.
  const same = deps.openItemsWithIdPrefix(stop.workspaceId, `nd-${lineKey}`).at(-1);
  if (same) return { opened: false, reason: 'already-open', itemId: same };
  const orchestratorTabId = await deps.orchestratorTabId(stop.workspaceId);
  if (!orchestratorTabId) return { opened: false, reason: 'no-orchestrator', itemId };
  const run = deps.openRuns(stop.workspaceId).find((r) => r.binding.tabId === orchestratorTabId);
  if (!run) return { opened: false, reason: 'no-orchestrator-run', itemId, detail: orchestratorTabId };
  const eventId = `${NEEDS_DECISION_EVENT_PREFIX}${itemId.slice(3)}`;
  const event = {
    eventId,
    schemaVersion: 1,
    type: 'attention.opened',
    workspaceId: stop.workspaceId,
    runId: run.runId,
    expectedRevision: 0,
    producerAt: deps.now(),
    bindingGeneration: run.binding.generation,
    payload: { itemId, ...questionOf(stop), humanReview: humanReviewOf(stop, orchestratorTabId) },
  };
  try {
    await deps.apply(stop.workspaceId, [event], { tabId: stop.tabId, identity: 'hook' }, {
      serverPrefix: NEEDS_DECISION_EVENT_PREFIX,
      ndLines: new Map([[eventId, { tabId: stop.tabId, lineKey, markedNew }]]),
    });
  } catch (err) {
    // Another opener took the line between the dedupe above and this write (#521 review r1, 1): the store's typed
    // refusal names the open item, so the line has its item and the owner was told; the line keeps that id.
    const open = isMissionControlError(err) && err.code === 'already-open' ? err.current?.id : undefined;
    if (open) {
      rememberId(lineKey, open, deps.now());
      log.info({ workspaceId: stop.workspaceId, tabId: stop.tabId, itemId, open }, 'NEEDS-DECISION item already open from another opener');
      return { opened: false, reason: 'already-open', itemId: open };
    }
    const detail = err instanceof Error ? err.message : String(err);
    log.warn({ workspaceId: stop.workspaceId, tabId: stop.tabId, itemId }, `NEEDS-DECISION item not opened: ${detail}`);
    return { opened: false, reason: 'refused', itemId, detail };
  }
  log.info({ workspaceId: stop.workspaceId, tabId: stop.tabId, itemId, runId: run.runId }, 'NEEDS-DECISION opened a Mission Control item');
  return { opened: true, itemId, runId: run.runId };
};

/** What the asking tab itself is told of its line (story 36, D1); `fate` says what the server did instead. */
export type TNeedsDecisionAskerNotice =
  | { kind: 'item'; state: 'opened' | 'already-open'; itemId: string; openIds?: string[] }
  /** The tab's open item now asks its line (story PM-2, D50); `replaced` is the decision it asked before. */
  | { kind: 'revised'; itemId: string; replaced: string }
  /** The owner already answered (story PM-2, D51): the answer, re-delivered; `differs`: the line is not the item's. */
  | { kind: 'answered'; itemId: string; answer: INeedsDecisionAnswerView; differs: boolean; question: string; askerIsOrchestrator: boolean }
  /** The line holds no `?`: the server opened nothing and told no one (D28). */
  | { kind: 'no-question' }
  | { kind: 'not-opened'; reason: TNeedsDecisionNoItemReason; itemId: string; detail?: string; fate: string; askerIsOrchestrator: boolean };

const NOTICE_DETAIL_MAX = 200;
const NEW_QUESTION_HINT = 'A different question: end on NEEDS-DECISION: [new] <question>?';

const clip = (text: string, max: number): { text: string; clipped: boolean } => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? { text: flat, clipped: false } : { text: `${flat.slice(0, max - 1).trimEnd()}…`, clipped: true };
};

/** The answer in one line: `(a) keep` options, then the text in quotes, clipped at 200 chars. */
export const needsDecisionAnswerText = (answer: INeedsDecisionAnswerView): { text: string; clipped: boolean } => {
  const options = answer.optionIds.map((id, i) => `(${id}) ${answer.optionLabels[i] ?? id}`).join(', ');
  const body = clip(answer.text, NOTICE_DETAIL_MAX);
  const text = [options, body.text ? `"${body.text}"` : ''].filter(Boolean).join('; ') || '(no option and no text)';
  return { text, clipped: body.clipped };
};

/** What became of the answer's delivery, for the asker and the nudge note: relayed, held with its reason, or in flight. */
export const needsDecisionDeliveryText = (answer: INeedsDecisionAnswerView, askerIsOrchestrator: boolean): string => {
  const { state, reason, tabId } = answer.delivery;
  if (state === 'submitted' || state === 'acknowledged') {
    return askerIsOrchestrator ? `It was delivered to you (delivery ${state})` : `It went to ${tabId ?? 'the orchestrator'} (delivery ${state}), which relays it`;
  }
  if (state === 'held' || state === 'failed') return `Delivery held: ${clip(reason ?? 'no reason recorded', NOTICE_DETAIL_MAX).text}`;
  return state ? `Delivery ${state}: on its way to ${tabId ?? 'the orchestrator'}` : 'No delivery is recorded';
};

export const needsDecisionAskerNotice = (notice: TNeedsDecisionAskerNotice): string => {
  if (notice.kind === 'no-question') {
    return '[needs-decision] item-not-opened: no-question. Your NEEDS-DECISION line holds no question mark after the marker, so the server opened no Mission Control item and told no one. If you need a decision, end on one line: NEEDS-DECISION: <question>? (a) <option> (b) <option>.';
  }
  if (notice.kind === 'item') {
    const state = notice.state === 'opened' ? 'opened for the owner by the server' : 'already open for the owner';
    const others = notice.openIds && notice.openIds.length > 1
      ? ` Your open items: ${notice.openIds.join(', ')}; your line revised none of them. ${NEW_QUESTION_HINT}`
      : '';
    return `[needs-decision] [MC item ${notice.itemId} ${state}: do not open another] Name this id while you wait; the owner's answer arrives through Mission Control.${others}`;
  }
  if (notice.kind === 'revised') {
    return `[needs-decision] [MC item ${notice.itemId} revised for the owner by the server: do not open another] Your line replaced the question "${clip(notice.replaced, NOTICE_DETAIL_MAX).text}". If yours is a different question, end on NEEDS-DECISION: [new] <question>? to open its own item.`;
  }
  if (notice.kind === 'answered') {
    const answer = needsDecisionAnswerText(notice.answer);
    const differs = notice.differs
      ? ` Your line differs from that item's question "${clip(notice.question, NOTICE_DETAIL_MAX).text}"; the owner answered that one.`
      : '';
    const clipped = answer.clipped ? ` (clipped; the whole answer is in item ${notice.itemId} and your orchestrator's relay)` : '';
    return `[needs-decision] [MC item ${notice.itemId} answered by the owner at ${new Date(notice.answer.answeredAt).toISOString()}: do not open another]${differs} The answer: ${answer.text}${clipped}. ${needsDecisionDeliveryText(notice.answer, notice.askerIsOrchestrator)}. ${NEW_QUESTION_HINT}`;
  }
  const detail = notice.detail ? ` (${notice.detail.replace(/\s+/g, ' ').trim().slice(0, NOTICE_DETAIL_MAX)})` : '';
  const own = notice.askerIsOrchestrator
    ? ` You are the orchestrator: resume or start your Mission Control run, then open item ${notice.itemId} from your line with your human review.`
    : '';
  return `[needs-decision] item-not-opened: ${notice.reason}${detail}. Your NEEDS-DECISION line opened no Mission Control item; ${notice.fate}. Its id would be ${notice.itemId}.${own}`;
};

/** The runtime wiring: the Mission Control store and the events route's own batch function. */
export const needsDecisionDeps = async (): Promise<INeedsDecisionDeps> => {
  const [{ getMissionControlStore }, { applyMissionEventBatch }, { getWorkspaceById }] = await Promise.all([
    import('@/lib/mission-control-store'),
    import('@/lib/mission-control-events'),
    import('@/lib/workspace-store'),
  ]);
  return {
    now: () => Date.now(),
    orchestratorTabId: async (workspaceId) => (await getWorkspaceById(workspaceId))?.orchestration?.orchestratorTabId ?? null,
    openRuns: (workspaceId) => getMissionControlStore().listOpenRunBindings(workspaceId),
    itemsOpenedByTab: (workspaceId, tabId, since) => getMissionControlStore().itemsOpenedByTab(workspaceId, tabId, since),
    openItemsWithIdPrefix: (workspaceId, prefix) => getMissionControlStore().openItemsWithIdPrefix(workspaceId, prefix),
    itemState: (itemId) => getMissionControlStore().itemStates([itemId]).get(itemId) ?? null,
    itemsOfTab: (workspaceId, tabId, lineKey, since) => getMissionControlStore().needsDecisionItemsOfTab(workspaceId, tabId, lineKey, since),
    recordLine: (workspaceId, tabId, lineKey, itemId, markedNew) =>
      getMissionControlStore().recordNeedsDecisionLine(workspaceId, tabId, lineKey, itemId, markedNew, Date.now()),
    apply: (workspaceId, events, opener, options) => applyMissionEventBatch(workspaceId, events, opener, options),
  };
};
