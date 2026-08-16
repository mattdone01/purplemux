import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAskQuestionPane, paneDigitForOption } from '@/lib/ask-user-question-pane';
import type { IAskUserQuestionItem } from '@/types/timeline';

// Every pane sample here is a real capture. See tests/fixtures/ask-user-question/README.md.
const FIXTURES = join(__dirname, '../../fixtures/ask-user-question');
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');

const option = (label: string) => ({ label, description: label });

// The exact tool input the captured session was driven with.
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

describe('parseAskQuestionPane', () => {
  it('reads question 1 of the initial two-question render', () => {
    expect(parseAskQuestionPane(fixture('01-question1'), QUESTIONS)).toEqual({
      phase: 'question',
      activeIndex: 0,
      answered: [false, false],
      complete: false,
      options: ['1. Red', '2. Green', '3. Blue', '4. Type something.', '5. Chat about this'],
      answers: [null, null],
    });
  });

  it('follows a Right-arrow move to question 2 instead of matching the operator prompt in the scrollback', () => {
    // The prompt that started this session quotes "Which colour?" above the tab
    // row. Matching the whole pane resolved question 1 here — the live body is
    // the only honest region.
    const state = parseAskQuestionPane(fixture('02-after-right'), QUESTIONS);

    expect(state.phase).toBe('question');
    expect(state.activeIndex).toBe(1);
    expect(state.options).toEqual(['1. Small', '2. Large', '3. Type something.', '4. Chat about this']);
  });

  it('treats a bare digit as select-and-advance, with the answered tab flipping to ☒', () => {
    const state = parseAskQuestionPane(fixture('04-after-digit-2'), QUESTIONS);

    expect(state).toMatchObject({ phase: 'question', activeIndex: 1, answered: [true, false] });
  });

  it('does not call the Submit tab complete when it was merely navigated to', () => {
    // Reached with Right/Right and nothing answered: the TUI still shows the
    // review screen, with a warning. Treating "review" as "all done" would have
    // the UI announce answers that do not exist.
    const state = parseAskQuestionPane(fixture('03-after-right-again'), QUESTIONS);

    expect(state).toMatchObject({
      phase: 'submit',
      activeIndex: 2,
      answered: [false, false],
      complete: false,
      options: ['1. Submit answers', '2. Cancel'],
    });
  });

  it('reports a complete Submit tab once every answer is in', () => {
    const state = parseAskQuestionPane(fixture('05-after-last-answer'), QUESTIONS);

    expect(state).toMatchObject({
      phase: 'submit',
      activeIndex: 2,
      answered: [true, true],
      complete: true,
      options: ['1. Submit answers', '2. Cancel'],
    });
  });

  it('recovers the chosen answer per question from the Submit tab echo', () => {
    expect(parseAskQuestionPane(fixture('05-after-last-answer'), QUESTIONS).answers)
      .toEqual(['Green', 'Small']);
  });

  it('leaves the answer echo empty when nothing has been chosen yet', () => {
    expect(parseAskQuestionPane(fixture('03-after-right-again'), QUESTIONS).answers)
      .toEqual([null, null]);
  });

  it('reports absent for the scrollback above the prompt', () => {
    const lines = fixture('01-question1').split('\n');
    const tabRow = lines.findIndex((line) => line.includes('Submit'));
    const scrollback = lines.slice(0, tabRow).join('\n');

    expect(parseAskQuestionPane(scrollback, QUESTIONS)).toMatchObject({
      phase: 'absent',
      activeIndex: -1,
      complete: false,
    });
  });

  it('refuses a tab row whose checkbox count does not match the question set', () => {
    expect(parseAskQuestionPane(fixture('01-question1'), [QUESTIONS[0]])).toMatchObject({
      phase: 'absent',
    });
  });

  it('returns absent for an empty question list', () => {
    expect(parseAskQuestionPane(fixture('01-question1'), [])).toMatchObject({ phase: 'absent' });
  });
});

// The three-question prompt from the second capture round: the shape of the
// original report, with a multiSelect in the middle and a long, wrapping third.
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

describe('parseAskQuestionPane — three questions', () => {
  it('reads a three-tab row that fits one line without truncation', () => {
    const state = parseAskQuestionPane(fixture('06-three-question-q1'), THREE);

    expect(state).toMatchObject({
      phase: 'question',
      activeIndex: 0,
      answered: [false, false, false],
      complete: false,
    });
  });

  it('matches a question whose text soft-wraps across two pane lines', () => {
    const state = parseAskQuestionPane(fixture('08-wrapped-question-q3'), THREE);

    expect(state.activeIndex).toBe(2);
    expect(state.options).toEqual(['1. Immediately', '2. Staged', '3. Type something.', '4. Chat about this']);
  });

  it('ignores option descriptions at either indentation — 5 spaces single-select, 2 multiSelect', () => {
    // 08 indents descriptions 5 spaces, 07 indents them 2 — the same depth as
    // the option lines themselves. Neither may become an option.
    expect(parseAskQuestionPane(fixture('08-wrapped-question-q3'), THREE).options)
      .not.toContain('Roll out to every workspace now.');
    expect(parseAskQuestionPane(fixture('07-multiselect-q2'), THREE).options)
      .toEqual(['1. [ ] Small', '2. [ ] Medium', '3. [ ] Large', '4. [ ] Type something', '5. Chat about this']);
  });

  it('does not mistake the unnumbered "Next" line of a multiSelect for an option', () => {
    const state = parseAskQuestionPane(fixture('07-multiselect-q2'), THREE);

    expect(state.options.some((o) => o.includes('Next'))).toBe(false);
  });

  it('treats a ☒ multiSelect tab as "at least one toggled", never as finished', () => {
    // One toggle flipped the tab; Small and Large are still clear.
    const state = parseAskQuestionPane(fixture('09-multiselect-after-digit'), THREE);

    expect(state).toMatchObject({ phase: 'question', activeIndex: 1, answered: [false, true, false] });
    expect(state.options).toContain('1. [ ] Small');
    expect(state.options).toContain('2. [✔] Medium');
    expect(state.complete).toBe(false);
  });

  it('reports absent after Escape, which cancels the whole prompt', () => {
    expect(parseAskQuestionPane(fixture('10-after-escape'), THREE)).toMatchObject({
      phase: 'absent',
      activeIndex: -1,
      options: [],
    });
  });
});

describe('paneDigitForOption', () => {
  const q1 = parseAskQuestionPane(fixture('01-question1'), QUESTIONS).options;
  const q2 = parseAskQuestionPane(fixture('02-after-right'), QUESTIONS).options;
  const submit = parseAskQuestionPane(fixture('05-after-last-answer'), QUESTIONS).options;

  it('reads the digit off the pane for each real option', () => {
    expect(paneDigitForOption(q1, 'Red')).toBe('1');
    expect(paneDigitForOption(q1, 'Green')).toBe('2');
    expect(paneDigitForOption(q1, 'Blue')).toBe('3');
    expect(paneDigitForOption(q2, 'Small')).toBe('1');
    expect(paneDigitForOption(q2, 'Large')).toBe('2');
  });

  it('refuses an option the live question does not offer, rather than typing into "Type something."', () => {
    // "Blue" is option 3 of question 1. Question 2's option 3 is the free-text
    // entry, so a stale model index would drop the operator into a text field.
    expect(q2[2]).toBe('3. Type something.');
    expect(paneDigitForOption(q2, 'Blue')).toBeNull();
  });

  it('resolves the submit choice by label so the review screen order is never assumed', () => {
    expect(paneDigitForOption(submit, 'Submit answers')).toBe('1');
    expect(paneDigitForOption(submit, 'Cancel')).toBe('2');
  });

  it('finds no digit for any multiSelect option, because the pane labels carry [ ] markers', () => {
    // Second line of defence: even if the refusal upstream were bypassed, there
    // is no digit to send. The advancing "Next" line has no number at all.
    const multi = parseAskQuestionPane(fixture('07-multiselect-q2'), THREE).options;

    expect(paneDigitForOption(multi, 'Small')).toBeNull();
    expect(paneDigitForOption(multi, 'Medium')).toBeNull();
    expect(paneDigitForOption(multi, 'Next')).toBeNull();
  });

  it('reads digits off the wrapped third question', () => {
    const rollout = parseAskQuestionPane(fixture('08-wrapped-question-q3'), THREE).options;

    expect(paneDigitForOption(rollout, 'Immediately')).toBe('1');
    expect(paneDigitForOption(rollout, 'Staged')).toBe('2');
  });

  it('refuses an empty or unmatched label', () => {
    expect(paneDigitForOption(q1, '')).toBeNull();
    expect(paneDigitForOption(q1, 'Magenta')).toBeNull();
    expect(paneDigitForOption([], 'Red')).toBeNull();
  });
});

// The widest prompt the AskUserQuestion schema permits: four questions (the cap)
// with headers at or near the 12-character cap.
const opt = (label: string) => ({ label, description: `Option ${label} for it.` });

const FOUR: IAskUserQuestionItem[] = [
  { header: 'Configuratn', question: 'Config?', multiSelect: false, options: [opt('A'), opt('B')] },
  { header: 'Environmnts', question: 'Env?', multiSelect: true, options: [opt('A'), opt('B')] },
  { header: 'Deploymentz', question: 'Deploy?', multiSelect: false, options: [opt('A'), opt('B')] },
  { header: 'Monitoringx', question: 'Monitor?', multiSelect: false, options: [opt('A'), opt('B')] },
];

describe('parseAskQuestionPane — the widest prompt the schema allows', () => {
  it('reads a four-tab row', () => {
    const state = parseAskQuestionPane(fixture('11-four-questions-max'), FOUR);

    expect(state).toMatchObject({
      phase: 'question',
      activeIndex: 0,
      answered: [false, false, false, false],
      complete: false,
      options: ['1. A', '2. B', '3. Type something.', '4. Chat about this'],
    });
  });

  it('leaves the single-line tab parser headroom at the capture width', () => {
    // parseTabRow reads ONE line, which holds only while the schema caps
    // questions at 4 and headers at 12 chars. Captures are forced to 120
    // columns; if this ever approaches it, the parser must span lines.
    const row = fixture('11-four-questions-max')
      .split('\n')
      .find((line) => line.includes('Submit')) as string;

    expect([...row]).toHaveLength(74);
    expect([...row].length).toBeLessThan(120);
  });

  it('recovers a multiSelect answer from the Submit review like any other', () => {
    // Environmnts is the multiSelect; with one option toggled it echoes as
    // "● Env? / → B", indistinguishable from a single-select answer.
    const state = parseAskQuestionPane(fixture('12-submit-with-multiselect'), FOUR);

    expect(state).toMatchObject({
      phase: 'submit',
      activeIndex: 4,
      answered: [true, true, true, true],
      complete: true,
      options: ['1. Submit answers', '2. Cancel'],
    });
    expect(state.answers).toEqual(['A', 'B', 'A', 'A']);
  });
});
