import { parseChoiceOptions, stripNumberPrefix, optionNumber } from '@/lib/permission-prompt';
import type { IAskUserQuestionItem } from '@/types/timeline';

export type TAskQuestionPhase = 'question' | 'submit' | 'absent' | 'unavailable';

export interface IAskQuestionPaneState {
  phase: TAskQuestionPhase;
  /** Question the TUI is showing; questions.length on the Submit tab, -1 otherwise. */
  activeIndex: number;
  /** Per-question tab checkbox: ☒ answered, ☐ not. Live even when the human answered in the terminal. */
  answered: boolean[];
  /** Every tab checked. The Submit tab is reachable with questions still open, so this is not implied by phase. */
  complete: boolean;
  /** Options exactly as the pane numbers them, including the synthetic trailing entries. */
  options: string[];
  /** Chosen answer per question as echoed on the Submit tab; null where the pane does not say. */
  answers: (string | null)[];
}

const CHECKBOX_RE = /[☐☒]/g;
const CHECKED = '☒';
// The Submit tab rides on the same row as the last header, after figures.tick.
const SUBMIT_TAB_RE = /[✔√]\s*Submit/;
const REVIEW_MARKER = 'Review your answers';
const INCOMPLETE_MARKER = 'You have not answered all questions';
const OPTION_LINE_RE = /^\s*[❯›>]?\s*\d+\.\s*\S/;
// The Submit tab echoes "● <question>" / "→ <chosen answer>" for each answered question.
const REVIEW_QUESTION_RE = /^\s*●\s*(\S.*)$/;
const REVIEW_ANSWER_RE = /^\s*→\s*(\S.*)$/;

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

const absent = (questions: IAskUserQuestionItem[]): IAskQuestionPaneState => ({
  phase: 'absent',
  activeIndex: -1,
  answered: questions.map(() => false),
  complete: false,
  options: [],
  answers: questions.map(() => null),
});

interface ITabRow {
  index: number;
  answered: boolean[];
  labels: string[];
}

/**
 * The tab row is read from a SINGLE line, and that is safe by construction
 * rather than by luck — but only because of the AskUserQuestion schema caps.
 *
 * The tool caps `questions` at 4 and `header` at 12 characters, so the widest
 * row the schema permits is
 *
 *   ←  ☐ Configuratn  ☐ Environmnts  ☐ Deploymentz  ☐ Monitoringx  ✔ Submit  →
 *
 * which measures 74 columns (fixture 11). Captures are taken at a forced width
 * of 120 (`capturePaneAtWidth(session, 120, 50)`) regardless of the operator's
 * real pane, leaving 46 columns of headroom in the worst legal case.
 *
 * IF EITHER CAP RISES, THIS ASSUMPTION DIES WITH IT. A wrapped row puts fewer
 * checkboxes on each line than there are questions, no line matches, and the
 * whole prompt reads as `absent` — the web UI then tells the operator to use
 * the terminal and does nothing. Safe, but useless; widen the capture or parse
 * across lines instead.
 */
const parseTabRow = (lines: string[], expected: number): ITabRow | null => {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const submit = line.match(SUBMIT_TAB_RE);
    const tabs = submit ? line.slice(0, submit.index) : line;
    const marks = tabs.match(CHECKBOX_RE);
    if (!marks || marks.length !== expected) continue;

    return {
      index: i,
      answered: marks.map((mark) => mark === CHECKED),
      labels: tabs.split(CHECKBOX_RE).slice(1).map(normalize),
    };
  }
  return null;
};

/** The lines above the tab row are scrollback — including the operator's own prompt, which
 *  quotes the question text and will otherwise match before the live question does. */
const bodyBelow = (lines: string[], tabRowIndex: number): string[] => lines.slice(tabRowIndex + 1);

const titleRegion = (body: string[]): string => {
  const end = body.findIndex((line) => OPTION_LINE_RE.test(line));
  return normalize((end === -1 ? body : body.slice(0, end)).join(' '));
};

const findRenderedQuestion = (body: string[], questions: IAskUserQuestionItem[]): number => {
  const texts = questions.map((question) => normalize(question.question));
  const title = titleRegion(body);
  const inTitle = texts.findIndex((text) => text.length > 0 && title.includes(text));
  if (inTitle >= 0) return inTitle;

  const whole = normalize(body.join(' '));
  return texts.findIndex((text) => text.length > 0 && whole.includes(text));
};

const parseReviewAnswers = (
  body: string[],
  questions: IAskUserQuestionItem[],
): (string | null)[] => {
  const answers: (string | null)[] = questions.map(() => null);
  let pending = -1;

  for (const line of body) {
    const asked = line.match(REVIEW_QUESTION_RE);
    if (asked) {
      const text = normalize(asked[1]);
      pending = questions.findIndex((question) => normalize(question.question) === text);
      continue;
    }

    const chose = line.match(REVIEW_ANSWER_RE);
    if (chose && pending >= 0) {
      answers[pending] = normalize(chose[1]);
      pending = -1;
    }
  }

  return answers;
};

/**
 * Resolve what an AskUserQuestion prompt is showing right now.
 *
 * Contract fixed by the real captures in tests/fixtures/ask-user-question/: a
 * multi-question prompt is a tabbed form, the tab checkboxes carry answered
 * state, and the Submit tab is reachable with questions still open.
 */
export const parseAskQuestionPane = (
  paneContent: string,
  questions: IAskUserQuestionItem[],
): IAskQuestionPaneState => {
  if (questions.length === 0) return absent(questions);

  const lines = paneContent.split('\n');
  const row = parseTabRow(lines, questions.length);
  if (!row) return absent(questions);

  const body = bodyBelow(lines, row.index);
  const bodyText = body.join('\n');
  const answered = row.answered;
  const complete = answered.every(Boolean) && !bodyText.includes(INCOMPLETE_MARKER);
  const options = parseChoiceOptions(bodyText).options;

  if (normalize(bodyText).includes(REVIEW_MARKER)) {
    const answers = parseReviewAnswers(body, questions);
    return { phase: 'submit', activeIndex: questions.length, answered, complete, options, answers };
  }

  const answers = questions.map(() => null);
  const rendered = findRenderedQuestion(body, questions);
  if (rendered >= 0) {
    return { phase: 'question', activeIndex: rendered, answered, complete, options, answers };
  }

  const firstUnanswered = answered.indexOf(false);
  if (firstUnanswered < 0) {
    return { phase: 'submit', activeIndex: questions.length, answered, complete, options, answers };
  }

  return { phase: 'question', activeIndex: firstUnanswered, answered, complete, options, answers };
};

/**
 * The digit that selects `label` in the pane as it is drawn right now.
 *
 * Never derive this from the model's own option index: the TUI appends
 * "Type something." and "Chat about this", and their numbers shift with the
 * option count (4/5 on a three-option question, 3/4 on a two-option one). A
 * stale index therefore sends the operator into a free-text field.
 */
export const paneDigitForOption = (paneOptions: string[], label: string): string | null => {
  const wanted = normalize(label);
  if (!wanted) return null;

  const matches = paneOptions.filter((option) => normalize(stripNumberPrefix(option)) === wanted);
  if (matches.length !== 1) return null;

  return optionNumber(matches[0]);
};
