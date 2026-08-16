import { paneDigitForOption } from '@/lib/ask-user-question-pane';
import type { IAskQuestionPaneState } from '@/lib/ask-user-question-pane';
import type { IAskUserQuestionItem } from '@/types/timeline';

export const ASK_ADVANCE_INTERVAL_MS = 400;
export const ASK_ADVANCE_TIMEOUT_MS = 6_000;
export const SUBMIT_OPTION_LABEL = 'Submit answers';

/**
 * A lone single-select question is the one shape Claude Code answers outright.
 * Everything else is a tabbed form that parks on a Submit tab and waits.
 */
export const isSingleShotPrompt = (questions: IAskUserQuestionItem[]): boolean =>
  questions.length === 1 && !questions[0].multiSelect;

/**
 * A multiSelect question cannot be answered with a digit.
 *
 * Its digits TOGGLE and do not advance (07/09 in the fixtures: sending `2` gave
 * `2. [✔] Medium` with the pane unmoved), and the `Next` line that does advance
 * carries no number at all. So there is no keystroke sequence to drive, and any
 * caller that sent a digit and then waited for movement would wait forever.
 */
export const isWebAnswerable = (question: IAskUserQuestionItem): boolean => !question.multiSelect;

/**
 * A `☒` tab on a multiSelect means "at least one option toggled", NOT "finished"
 * (fixture 09: the tab flipped on the first toggle with two options still clear).
 * So a form containing one is never committed automatically — the operator has
 * to look at it and press submit themselves.
 */
export const formHasMultiSelect = (questions: IAskUserQuestionItem[]): boolean =>
  questions.some((question) => question.multiSelect);

export type TAttemptStatus =
  | 'answered'
  | 'multi-select'
  | 'submitted'
  | 'moved'
  | 'incomplete'
  | 'no-match'
  | 'send-failed'
  | 'stalled'
  | 'unavailable';

export interface IAttempt {
  status: TAttemptStatus;
  state?: IAskQuestionPaneState;
}

export interface IPollResult {
  ok: boolean;
  reason?: 'timeout' | 'unavailable';
  state?: IAskQuestionPaneState;
}

interface IPollInput {
  read: () => Promise<IAskQuestionPaneState>;
  sleep: (ms: number) => Promise<void>;
  done: (state: IAskQuestionPaneState) => boolean;
  intervalMs?: number;
  timeoutMs?: number;
}

const pollUntil = async ({
  read,
  sleep,
  done,
  intervalMs = ASK_ADVANCE_INTERVAL_MS,
  timeoutMs = ASK_ADVANCE_TIMEOUT_MS,
}: IPollInput): Promise<IPollResult> => {
  const attempts = Math.max(1, Math.floor(timeoutMs / intervalMs));
  let everReadable = false;

  for (let i = 0; i < attempts; i += 1) {
    await sleep(intervalMs);
    const state = await read();
    if (state.phase === 'unavailable') continue;

    everReadable = true;
    if (done(state)) return { ok: true, state };
  }

  return { ok: false, reason: everReadable ? 'timeout' : 'unavailable' };
};

interface IWaitForAdvanceInput extends Omit<IPollInput, 'done'> {
  fromIndex: number;
}

/** Bounded wait for the TUI to leave `fromIndex`. Never silent: it reports why it gave up. */
export const waitForAdvance = ({ fromIndex, ...rest }: IWaitForAdvanceInput): Promise<IPollResult> =>
  pollUntil({
    ...rest,
    done: (state) =>
      state.phase === 'absent' || state.phase === 'submit' || state.activeIndex > fromIndex,
  });

export const waitForPromptGone = (input: Omit<IPollInput, 'done'>): Promise<IPollResult> =>
  pollUntil({ ...input, done: (state) => state.phase === 'absent' });

const failureOf = (result: IPollResult): IAttempt => ({
  status: result.reason === 'unavailable' ? 'unavailable' : 'stalled',
  state: result.state,
});

interface IAnswerQuestionInput {
  question: IAskUserQuestionItem;
  questionIndex: number;
  optionLabel: string;
  read: () => Promise<IAskQuestionPaneState>;
  sendDigit: (digit: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Answer ONE question of a tabbed prompt.
 *
 * Re-reads the pane before sending, then takes the digit off that read. The
 * operator may have answered in the terminal a moment ago, and the TUI's option
 * numbering shifts per question — sending a remembered index can select the
 * free-text entry of a question we were never looking at.
 */
export const answerQuestion = async ({
  question,
  questionIndex,
  optionLabel,
  read,
  sendDigit,
  sleep,
}: IAnswerQuestionInput): Promise<IAttempt> => {
  // Refused before anything else runs: no read, no keystroke, and above all no
  // wait — a multiSelect digit never moves the pane, so the wait would not end.
  if (!isWebAnswerable(question)) return { status: 'multi-select' };

  const before = await read();
  if (before.phase === 'unavailable') return { status: 'unavailable' };
  if (before.phase !== 'question' || before.activeIndex !== questionIndex) {
    return { status: 'moved', state: before };
  }

  const digit = paneDigitForOption(before.options, optionLabel);
  if (!digit) return { status: 'no-match', state: before };

  if (!(await sendDigit(digit))) return { status: 'send-failed', state: before };

  const advanced = await waitForAdvance({ fromIndex: questionIndex, read, sleep });
  return advanced.ok ? { status: 'answered', state: advanced.state } : failureOf(advanced);
};

interface ISubmitAnswersInput {
  read: () => Promise<IAskQuestionPaneState>;
  sendDigit: (digit: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Commit the form from the Submit tab.
 *
 * Answering every question is NOT enough: the TUI parks on Submit and waits
 * indefinitely (verified by waiting 8s against a live prompt). Without this the
 * prompt still hangs, one step later than before.
 */
export const submitAnswers = async ({
  read,
  sendDigit,
  sleep,
}: ISubmitAnswersInput): Promise<IAttempt> => {
  const before = await read();
  if (before.phase === 'unavailable') return { status: 'unavailable' };
  if (before.phase !== 'submit') return { status: 'moved', state: before };
  if (!before.complete) return { status: 'incomplete', state: before };

  const digit = paneDigitForOption(before.options, SUBMIT_OPTION_LABEL);
  if (!digit) return { status: 'no-match', state: before };

  if (!(await sendDigit(digit))) return { status: 'send-failed', state: before };

  const gone = await waitForPromptGone({ read, sleep });
  return gone.ok ? { status: 'submitted', state: gone.state } : failureOf(gone);
};

interface IAnswerAndSubmitInput extends Omit<IAnswerQuestionInput, 'question'> {
  questions: IAskUserQuestionItem[];
}

/**
 * Answer a question and, when that lands the form on a complete Submit tab,
 * commit it in the same gesture. Returns every step so the caller can report
 * exactly where it stopped.
 */
export const answerAndSubmit = async (input: IAnswerAndSubmitInput): Promise<IAttempt[]> => {
  const { questions, questionIndex } = input;
  const answered = await answerQuestion({ ...input, question: questions[questionIndex] });
  if (answered.status !== 'answered') return [answered];
  if (answered.state?.phase !== 'submit' || !answered.state.complete) return [answered];
  if (formHasMultiSelect(questions)) return [answered];

  return [answered, await submitAnswers(input)];
};
