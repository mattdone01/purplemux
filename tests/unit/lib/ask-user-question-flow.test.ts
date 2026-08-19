import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  answerAndSubmit,
  answerQuestion,
  formHasMultiSelect,
  ASK_ADVANCE_INTERVAL_MS,
  ASK_ADVANCE_TIMEOUT_MS,
  isSingleShotPrompt,
  isWebAnswerable,
  submitAnswers,
} from '@/lib/ask-user-question-flow';
import { parseAskQuestionPane } from '@/lib/ask-user-question-pane';
import type { IAskQuestionPaneState } from '@/lib/ask-user-question-pane';
import type { IAskUserQuestionItem } from '@/types/timeline';

// Every pane state below is parsed from a real capture.
// See tests/fixtures/ask-user-question/README.md.
const FIXTURES = join(__dirname, '../../fixtures/ask-user-question');
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');

const option = (label: string) => ({ label, description: label });

const QUESTIONS: IAskUserQuestionItem[] = [
  {
    header: 'Colour',
    question: 'Which colour?',
    multiSelect: false,
    options: [option('Red'), option('Green'), option('Blue')],
  },
  {
    header: 'Size',
    question: 'Which size?',
    multiSelect: false,
    options: [option('Small'), option('Large')],
  },
];

const at = (name: string): IAskQuestionPaneState => parseAskQuestionPane(fixture(name), QUESTIONS);

const gone = (): IAskQuestionPaneState => {
  const lines = fixture('01-question1').split('\n');
  const tabRow = lines.findIndex((line) => line.includes('Submit'));
  return parseAskQuestionPane(lines.slice(0, tabRow).join('\n'), QUESTIONS);
};

const UNREADABLE: IAskQuestionPaneState = {
  phase: 'unavailable',
  activeIndex: -1,
  answered: [],
  complete: false,
  options: [],
  answers: [],
};

/** Reads the scripted states in order, then repeats the last one forever. */
const reader = (states: IAskQuestionPaneState[]) => {
  let call = 0;
  return vi.fn(async () => states[Math.min(call++, states.length - 1)]);
};

const noSleep = async () => {};

describe('isSingleShotPrompt', () => {
  it('is true only for one single-select question — the shape with no Submit tab', () => {
    expect(isSingleShotPrompt([QUESTIONS[0]])).toBe(true);
    expect(isSingleShotPrompt(QUESTIONS)).toBe(false);
    expect(isSingleShotPrompt([{ ...QUESTIONS[0], multiSelect: true }])).toBe(false);
    expect(isSingleShotPrompt([])).toBe(false);
  });
});

describe('isWebAnswerable', () => {
  it('refuses multiSelect questions — a digit cannot toggle a set and press Submit', () => {
    expect(isWebAnswerable(QUESTIONS[0])).toBe(true);
    expect(isWebAnswerable({ ...QUESTIONS[0], multiSelect: true })).toBe(false);
  });
});

describe('answerQuestion', () => {
  it('sends the digit the live pane assigns to the chosen label, then waits for the tab to flip', async () => {
    const sendDigit = vi.fn(async () => true);

    const attempt = await answerQuestion({
      question: QUESTIONS[0],
      questionIndex: 0,
      optionLabel: 'Green',
      read: reader([at('01-question1'), at('04-after-digit-2')]),
      sendDigit,
      sleep: noSleep,
    });

    expect(sendDigit).toHaveBeenCalledExactlyOnceWith('2');
    expect(attempt.status).toBe('answered');
    expect(attempt.state).toMatchObject({ activeIndex: 1, answered: [true, false] });
  });

  it('numbers the digit from the pane, not the model index, so option counts may differ per question', async () => {
    const sendDigit = vi.fn(async () => true);

    await answerQuestion({
      question: QUESTIONS[1],
      questionIndex: 1,
      optionLabel: 'Large',
      read: reader([at('02-after-right'), at('05-after-last-answer')]),
      sendDigit,
      sleep: noSleep,
    });

    // "Large" is the model's option 2 of question 2 and the pane's "2. Large".
    expect(sendDigit).toHaveBeenCalledExactlyOnceWith('2');
  });

  it('refuses to send when the operator already moved the TUI elsewhere', async () => {
    const sendDigit = vi.fn(async () => true);

    // The UI still believes question 1 is live; the pane is on question 2.
    const attempt = await answerQuestion({
      question: QUESTIONS[0],
      questionIndex: 0,
      optionLabel: 'Blue',
      read: reader([at('02-after-right')]),
      sendDigit,
      sleep: noSleep,
    });

    expect(attempt).toMatchObject({ status: 'moved' });
    expect(attempt.state?.activeIndex).toBe(1);
    expect(sendDigit).not.toHaveBeenCalled();
  });

  it('refuses a label the live question does not offer instead of typing into "Type something."', async () => {
    const sendDigit = vi.fn(async () => true);

    const attempt = await answerQuestion({
      question: QUESTIONS[1],
      questionIndex: 1,
      optionLabel: 'Blue',
      read: reader([at('02-after-right')]),
      sendDigit,
      sleep: noSleep,
    });

    expect(attempt.status).toBe('no-match');
    expect(sendDigit).not.toHaveBeenCalled();
  });

  it('never bursts a second digit while the pane stays on the same question', async () => {
    const sendDigit = vi.fn(async () => true);

    const attempt = await answerQuestion({
      question: QUESTIONS[0],
      questionIndex: 0,
      optionLabel: 'Green',
      read: reader([at('01-question1')]),
      sendDigit,
      sleep: noSleep,
    });

    expect(sendDigit).toHaveBeenCalledTimes(1);
    expect(attempt.status).toBe('stalled');
  });

  it('does not poll when the keystroke could not be delivered', async () => {
    const read = reader([at('01-question1')]);

    const attempt = await answerQuestion({
      question: QUESTIONS[0],
      questionIndex: 0,
      optionLabel: 'Green',
      read,
      sendDigit: async () => false,
      sleep: noSleep,
    });

    expect(attempt.status).toBe('send-failed');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reports an unreadable pane rather than sending blind', async () => {
    const sendDigit = vi.fn(async () => true);

    const attempt = await answerQuestion({
      question: QUESTIONS[0],
      questionIndex: 0,
      optionLabel: 'Green',
      read: reader([UNREADABLE]),
      sendDigit,
      sleep: noSleep,
    });

    expect(attempt.status).toBe('unavailable');
    expect(sendDigit).not.toHaveBeenCalled();
  });

  it('bounds the wait rather than hanging', async () => {
    const sleep = vi.fn(async () => {});
    const read = reader([at('01-question1')]);

    await answerQuestion({
      question: QUESTIONS[0],
      questionIndex: 0,
      optionLabel: 'Green',
      read,
      sendDigit: async () => true,
      sleep,
    });

    const polls = Math.floor(ASK_ADVANCE_TIMEOUT_MS / ASK_ADVANCE_INTERVAL_MS);
    expect(sleep).toHaveBeenCalledWith(ASK_ADVANCE_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(polls + 1);
  });
});

describe('submitAnswers', () => {
  it('commits the form from a complete Submit tab and waits for the prompt to disappear', async () => {
    const sendDigit = vi.fn(async () => true);

    const attempt = await submitAnswers({
      read: reader([at('05-after-last-answer'), gone()]),
      sendDigit,
      sleep: noSleep,
    });

    expect(sendDigit).toHaveBeenCalledExactlyOnceWith('1');
    expect(attempt.status).toBe('submitted');
  });

  it('refuses to submit a form that only looks finished because Submit was navigated to', async () => {
    const sendDigit = vi.fn(async () => true);

    const attempt = await submitAnswers({
      read: reader([at('03-after-right-again')]),
      sendDigit,
      sleep: noSleep,
    });

    expect(attempt).toMatchObject({ status: 'incomplete' });
    expect(attempt.state?.answered).toEqual([false, false]);
    expect(sendDigit).not.toHaveBeenCalled();
  });

  it('refuses to submit while the TUI is still on a question', async () => {
    const sendDigit = vi.fn(async () => true);

    const attempt = await submitAnswers({
      read: reader([at('01-question1')]),
      sendDigit,
      sleep: noSleep,
    });

    expect(attempt.status).toBe('moved');
    expect(sendDigit).not.toHaveBeenCalled();
  });

  it('reports a stall when the prompt never clears', async () => {
    const attempt = await submitAnswers({
      read: reader([at('05-after-last-answer')]),
      sendDigit: async () => true,
      sleep: noSleep,
    });

    expect(attempt.status).toBe('stalled');
  });
});

describe('answerAndSubmit', () => {
  it('answers the last question and commits, because the TUI parks on Submit and never self-submits', async () => {
    const sent: string[] = [];

    const steps = await answerAndSubmit({
      questions: QUESTIONS,
      questionIndex: 1,
      optionLabel: 'Small',
      read: reader([
        at('02-after-right'),        // pre-send check: question 2 is live
        at('05-after-last-answer'),  // advance confirmed: parked on Submit, complete
        at('05-after-last-answer'),  // submit pre-check
        gone(),                      // prompt cleared
      ]),
      sendDigit: async (digit) => {
        sent.push(digit);
        return true;
      },
      sleep: noSleep,
    });

    expect(sent).toEqual(['1', '1']);
    expect(steps.map((s) => s.status)).toEqual(['answered', 'submitted']);
  });

  it('stops after answering when more questions remain', async () => {
    const sent: string[] = [];

    const steps = await answerAndSubmit({
      questions: QUESTIONS,
      questionIndex: 0,
      optionLabel: 'Green',
      read: reader([at('01-question1'), at('04-after-digit-2')]),
      sendDigit: async (digit) => {
        sent.push(digit);
        return true;
      },
      sleep: noSleep,
    });

    expect(sent).toEqual(['2']);
    expect(steps.map((s) => s.status)).toEqual(['answered']);
  });

  it('does not chain a submit when the Submit tab is reached with questions still open', async () => {
    const sent: string[] = [];

    const steps = await answerAndSubmit({
      questions: QUESTIONS,
      questionIndex: 0,
      optionLabel: 'Green',
      read: reader([at('01-question1'), at('03-after-right-again')]),
      sendDigit: async (digit) => {
        sent.push(digit);
        return true;
      },
      sleep: noSleep,
    });

    expect(sent).toEqual(['2']);
    expect(steps.map((s) => s.status)).toEqual(['answered']);
  });
});

// The three-question form from the second capture round, with a multiSelect
// sitting in the middle of it.
const THREE: IAskUserQuestionItem[] = [
  {
    header: 'Colour',
    question: 'Which colour?',
    multiSelect: false,
    options: [option('Red'), option('Green'), option('Blue')],
  },
  {
    header: 'Sizes',
    question: 'Which sizes should we stock for the initial run?',
    multiSelect: true,
    options: [option('Small'), option('Medium'), option('Large')],
  },
  {
    header: 'Rollout',
    question:
      'Should we roll this out to every workspace immediately, or stage it behind a flag '
      + 'for a week first so we can watch the error rate before committing?',
    multiSelect: false,
    options: [option('Immediately'), option('Staged')],
  },
];

const three = (name: string): IAskQuestionPaneState =>
  parseAskQuestionPane(fixture(name), THREE);

describe('multiSelect questions', () => {
  it('is detected anywhere in the form', () => {
    expect(formHasMultiSelect(THREE)).toBe(true);
    expect(formHasMultiSelect(QUESTIONS)).toBe(false);
  });

  it('never reaches the pane, the keystroke, or above all the wait', async () => {
    // A multiSelect digit toggles without moving the pane (fixture 09), so a
    // send-then-wait would never terminate. The refusal happens before any I/O.
    const read = vi.fn(async () => three('07-multiselect-q2'));
    const sendDigit = vi.fn(async () => true);
    const sleep = vi.fn(async () => {});

    const attempt = await answerQuestion({
      question: THREE[1],
      questionIndex: 1,
      optionLabel: 'Medium',
      read,
      sendDigit,
      sleep,
    });

    expect(attempt).toEqual({ status: 'multi-select' });
    expect(read).not.toHaveBeenCalled();
    expect(sendDigit).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('still answers the single-select questions of a form that contains one', async () => {
    const sendDigit = vi.fn(async () => true);

    const attempt = await answerQuestion({
      question: THREE[2],
      questionIndex: 2,
      optionLabel: 'Staged',
      read: reader([three('08-wrapped-question-q3'), three('10-after-escape')]),
      sendDigit,
      sleep: noSleep,
    });

    expect(sendDigit).toHaveBeenCalledExactlyOnceWith('2');
    expect(attempt.status).toBe('answered');
  });

  it('refuses to submit while the TUI sits on the multiSelect question', async () => {
    const sendDigit = vi.fn(async () => true);

    const attempt = await submitAnswers({
      read: reader([three('09-multiselect-after-digit')]),
      sendDigit,
      sleep: noSleep,
    });

    expect(attempt.status).toBe('moved');
    expect(sendDigit).not.toHaveBeenCalled();
  });

  it('blocks the submit while any tab is still ☐, including an untouched multiSelect', async () => {
    // completeness is read off the tab row, and fixture 09 proves that row
    // tracks the multiSelect too.
    expect(three('09-multiselect-after-digit').answered).toEqual([false, true, false]);
    expect(three('09-multiselect-after-digit').complete).toBe(false);
  });

});

// The widest prompt the schema allows: four questions, one of them multiSelect.
const opt = (label: string) => ({ label, description: `Option ${label} for it.` });

const FOUR: IAskUserQuestionItem[] = [
  { header: 'Configuratn', question: 'Config?', multiSelect: false, options: [opt('A'), opt('B')] },
  { header: 'Environmnts', question: 'Env?', multiSelect: true, options: [opt('A'), opt('B')] },
  { header: 'Deploymentz', question: 'Deploy?', multiSelect: false, options: [opt('A'), opt('B')] },
  { header: 'Monitoringx', question: 'Monitor?', multiSelect: false, options: [opt('A'), opt('B')] },
];

const four = (name: string): IAskQuestionPaneState => parseAskQuestionPane(fixture(name), FOUR);

/** Escape and a completed submit both leave a pane with no prompt on it; this
 *  asserts only that no prompt is present. */
const promptCleared = (): IAskQuestionPaneState => four('10-after-escape');

describe('a four-question form containing a multiSelect', () => {
  it('never auto-commits, even though the pane reports every tab ☒ and complete', async () => {
    const sent: string[] = [];

    const steps = await answerAndSubmit({
      questions: FOUR,
      questionIndex: 0,
      optionLabel: 'A',
      read: reader([four('11-four-questions-max'), four('12-submit-with-multiselect')]),
      sendDigit: async (digit) => {
        sent.push(digit);
        return true;
      },
      sleep: noSleep,
    });

    expect(four('12-submit-with-multiselect').complete).toBe(true);
    expect(sent).toEqual(['1']);
    expect(steps.map((s) => s.status)).toEqual(['answered']);
  });

  it('still submits on an explicit request — the refusal is only of the automatic chain', async () => {
    const sendDigit = vi.fn(async () => true);

    const attempt = await submitAnswers({
      read: reader([four('12-submit-with-multiselect'), promptCleared()]),
      sendDigit,
      sleep: noSleep,
    });

    expect(sendDigit).toHaveBeenCalledExactlyOnceWith('1');
    expect(attempt.status).toBe('submitted');
  });
});

describe('createPaneWatcher', () => {
  const state = (over: Partial<IAskQuestionPaneState> = {}): IAskQuestionPaneState => ({
    phase: 'question',
    activeIndex: 0,
    answered: [false, false],
    complete: false,
    options: ['1. Red', '2. Blue'],
    answers: [null, null],
    ...over,
  });

  const drive = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('heals the mount race: absent before the TUI paints, question on a later tick', async () => {
    vi.useFakeTimers();
    try {
      const { createPaneWatcher, ASK_PANE_POLL_MS } = await import('@/lib/ask-user-question-flow');
      const reads = [state({ phase: 'absent', activeIndex: -1 }), state()];
      const read = vi.fn(async () => reads.shift() ?? state());
      const seen: IAskQuestionPaneState[] = [];
      const watcher = createPaneWatcher({ read, onState: (s) => seen.push(s) });
      watcher.start();
      await drive(0);
      expect(seen.map((s) => s.phase)).toEqual(['absent']);
      await drive(ASK_PANE_POLL_MS);
      expect(seen.map((s) => s.phase)).toEqual(['absent', 'question']);
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers only changes — an unchanged pane does not re-render the card', async () => {
    vi.useFakeTimers();
    try {
      const { createPaneWatcher, ASK_PANE_POLL_MS } = await import('@/lib/ask-user-question-flow');
      const read = vi.fn(async () => state());
      const seen: IAskQuestionPaneState[] = [];
      const watcher = createPaneWatcher({ read, onState: (s) => seen.push(s) });
      watcher.start();
      await drive(ASK_PANE_POLL_MS * 3);
      expect(read.mock.calls.length).toBeGreaterThan(2);
      expect(seen).toHaveLength(1);
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sees the terminal answering a question while the card is open', async () => {
    vi.useFakeTimers();
    try {
      const { createPaneWatcher, ASK_PANE_POLL_MS } = await import('@/lib/ask-user-question-flow');
      const reads = [state(), state({ activeIndex: 1, answered: [true, false] })];
      const read = vi.fn(async () => reads.shift() ?? state({ activeIndex: 1, answered: [true, false] }));
      const seen: IAskQuestionPaneState[] = [];
      const watcher = createPaneWatcher({ read, onState: (s) => seen.push(s) });
      watcher.start();
      await drive(ASK_PANE_POLL_MS);
      expect(seen).toHaveLength(2);
      expect(seen[1].activeIndex).toBe(1);
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses while an answer is in flight and resumes after', async () => {
    vi.useFakeTimers();
    try {
      const { createPaneWatcher, ASK_PANE_POLL_MS } = await import('@/lib/ask-user-question-flow');
      let paused = true;
      const read = vi.fn(async () => state());
      const watcher = createPaneWatcher({ read, onState: () => {}, isPaused: () => paused });
      watcher.start();
      await drive(ASK_PANE_POLL_MS * 3);
      expect(read).not.toHaveBeenCalled();
      paused = false;
      await drive(ASK_PANE_POLL_MS);
      expect(read).toHaveBeenCalled();
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop cancels the loop, including a read already scheduled', async () => {
    vi.useFakeTimers();
    try {
      const { createPaneWatcher, ASK_PANE_POLL_MS } = await import('@/lib/ask-user-question-flow');
      const read = vi.fn(async () => state());
      const watcher = createPaneWatcher({ read, onState: () => {} });
      watcher.start();
      await drive(0);
      const calls = read.mock.calls.length;
      watcher.stop();
      await drive(ASK_PANE_POLL_MS * 3);
      expect(read.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
