import { paneAsSeen, readComposer } from '@/lib/composer-readiness';
import type { ISubmitEvidence } from '@/types/status';
import type { TPanelType } from '@/types/terminal';

/**
 * vel-RETRO-R3 (retro 2026-11-09): a `/party` brief sent to a fresh tab was typed and never submitted, `tab send`
 * exited 0, and the receiver sat idle for 15 minutes. After the typing, the send now looks for proof that the
 * agent took the turn, presses Enter once more for text that stayed in the composer (L37), and names the failure
 * when no proof comes. Ruling: `docs/design/vel-retro-r3-send-confirm.md`.
 */

export const SUBMIT_CONFIRM_POLL_MS = 250;
export const SUBMIT_CONFIRM_LOCAL_MS = 5_000;
/** A remote tab's hook crosses the tailnet and its capture is one ssh call (ADR-0022). */
export const SUBMIT_CONFIRM_REMOTE_MS = 10_000;
/** The one extra Enter waits this long: `submitComposer` has already pressed Enter twice, 600 ms apart. */
export const SUBMIT_RETRY_AFTER_MS = 1_500;

export type TSubmitConfirmation = 'prompt-submit' | 'composer-empty';

export type TNotSubmitted = 'typed-not-submitted' | 'submit-unconfirmed';

export type TSubmitResult =
  | { submitted: true; confirmation: TSubmitConfirmation; resubmitted: boolean }
  | { submitted: false; notSubmitted: TNotSubmitted; resubmitted: boolean };

/**
 * Whether the tab's agent reports a turn start through a `prompt-submit` hook. Claude does on both hosts (the
 * remote hook, ADR-0022 §16); Codex and Grok do here and have no remote hook. Only a tab without the hook may take
 * an empty composer as proof: on the others an empty composer is also what keys lost during a boot leave.
 */
export const hasPromptSubmitHook = (panelType: TPanelType | undefined, remote: boolean): boolean =>
  panelType === 'claude-code' || (!remote && (panelType === 'codex-cli' || panelType === 'grok-cli'));

/** A turn-starting submit after the baseline, or `busy` from a state that was not, unless a Codex tool event set it. */
export const hasSubmitProof = (baseline: ISubmitEvidence, current: ISubmitEvidence | null): boolean => {
  if (!current) return false;
  if (current.lastPromptSubmitSeq !== null && current.lastPromptSubmitSeq > baseline.eventSeq) return true;
  return baseline.cliState !== 'busy' && current.cliState === 'busy' && !current.lastEventFromTool;
};

export interface ISubmitConfirmDeps {
  readEvidence: () => ISubmitEvidence | null;
  /** The pane with its escapes, so a dim suggestion reads as an empty composer; null when it cannot be read. */
  capture: () => Promise<string | null>;
  /** Whether the whole first line of the content sits in the input box (`isPaneShowingPendingLine`). */
  isPendingLine: (plainPane: string, content: string) => boolean;
  pressEnter: () => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ISubmitConfirmRequest {
  panelType: TPanelType | undefined;
  remote: boolean;
  content: string;
  /** Read inside the dispatch lock just before the typing. */
  baseline: ISubmitEvidence;
  /** The readiness gate read an empty composer before the typing. */
  screenEmptyAtGate: boolean;
}

interface IScreenReading {
  composer: 'empty' | 'text' | 'unreadable';
  firstLinePending: boolean;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const readScreen = async (deps: ISubmitConfirmDeps, request: ISubmitConfirmRequest): Promise<IScreenReading> => {
  const captured = await deps.capture().catch(() => null);
  if (!captured) return { composer: 'unreadable', firstLinePending: false };
  return {
    composer: readComposer(request.panelType, captured),
    firstLinePending: deps.isPendingLine(paneAsSeen(request.panelType, captured), request.content),
  };
};

/**
 * Text the gate did not put there: the content's first line, or any text when the gate saw an empty composer.
 * The second catches a long typed brief that Claude Code folds to a `[Pasted text]` placeholder, where the
 * first-line match fails.
 */
const strandedText = (screen: IScreenReading, screenEmptyAtGate: boolean): boolean =>
  screen.firstLinePending || (screen.composer === 'text' && screenEmptyAtGate);

/**
 * Poll after the typing until a proof, or the deadline. A failed capture is never proof, and neither is an empty
 * composer on a tab with a prompt-submit hook. Enter is pressed at most once more.
 */
export const confirmSubmission = async (
  deps: ISubmitConfirmDeps,
  request: ISubmitConfirmRequest,
): Promise<TSubmitResult> => {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? realSleep;
  const deadlineMs = request.remote ? SUBMIT_CONFIRM_REMOTE_MS : SUBMIT_CONFIRM_LOCAL_MS;
  const screenProves = !hasPromptSubmitHook(request.panelType, request.remote);
  const startedAt = now();
  let resubmitted = false;

  for (;;) {
    if (hasSubmitProof(request.baseline, deps.readEvidence())) {
      return { submitted: true, confirmation: 'prompt-submit', resubmitted };
    }
    const screen = await readScreen(deps, request);
    if (screenProves && screen.composer === 'empty' && !screen.firstLinePending) {
      return { submitted: true, confirmation: 'composer-empty', resubmitted };
    }
    const elapsed = now() - startedAt;
    if (elapsed >= deadlineMs) {
      return {
        submitted: false,
        notSubmitted: strandedText(screen, request.screenEmptyAtGate) ? 'typed-not-submitted' : 'submit-unconfirmed',
        resubmitted,
      };
    }
    if (!resubmitted && elapsed >= SUBMIT_RETRY_AFTER_MS && strandedText(screen, request.screenEmptyAtGate)) {
      resubmitted = true;
      await deps.pressEnter().catch(() => undefined);
    }
    await sleep(Math.min(SUBMIT_CONFIRM_POLL_MS, deadlineMs - elapsed));
  }
};
