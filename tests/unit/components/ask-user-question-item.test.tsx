import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import type { ITimelineAskUserQuestion, IAskUserQuestionItem, TToolStatus } from '@/types/timeline';
import timelineMessages from '../../../messages/en/timeline.json';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const { default: AskUserQuestionItem } = await import('@/components/features/timeline/ask-user-question-item');

const option = (label: string) => ({ label, description: `why ${label}` });

// Mirrors the tool input behind tests/fixtures/ask-user-question/.
const COLOUR: IAskUserQuestionItem = {
  header: 'Colour',
  question: 'Which colour?',
  multiSelect: false,
  options: [option('Red'), option('Green'), option('Blue')],
};

const SIZE: IAskUserQuestionItem = {
  header: 'Size',
  question: 'Which size?',
  multiSelect: false,
  options: [option('Small'), option('Large')],
};

const entry = (
  questions: IAskUserQuestionItem[],
  over: Partial<ITimelineAskUserQuestion> = {},
): ITimelineAskUserQuestion => ({
  id: 'e1',
  type: 'ask-user-question',
  timestamp: 0,
  toolUseId: 't1',
  questions,
  status: 'pending' as TToolStatus,
  ...over,
});

const render = (e: ITimelineAskUserQuestion, sessionName?: string): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ timeline: timelineMessages }}>
      <AskUserQuestionItem entry={e} sessionName={sessionName} />
    </NextIntlClientProvider>,
  );

describe('AskUserQuestionItem — multi-question prompt', () => {
  it('renders every question, not just the first', () => {
    const html = render(entry([COLOUR, SIZE]), 's1');

    for (const q of [COLOUR, SIZE]) {
      expect(html).toContain(q.header);
      expect(html).toContain(q.question);
      for (const o of q.options) expect(html).toContain(o.label);
    }
    expect(html).toContain('why Large');
  });

  it('always shows the submit step, because the TUI parks on Submit and never self-submits', () => {
    const html = render(entry([COLOUR, SIZE]), 's1');

    expect(html).toContain(timelineMessages.askSubmitPending);
  });

  it('leaves every option disabled until the pane says which tab is live', () => {
    const html = render(entry([COLOUR, SIZE]), 's1');

    expect(html.match(/<button[^>]*disabled/g)).toHaveLength(5);
  });

  it('refuses a multiSelect question rather than pretending a digit answers it', () => {
    const html = render(entry([COLOUR, { ...SIZE, multiSelect: true }]), 's1');

    expect(html).toContain(timelineMessages.askMultiSelectTerminal);
  });

  it('reports the prompt as submitted once the tool result lands', () => {
    const html = render(entry([COLOUR, SIZE], { status: 'success' }), 's1');

    expect(html).toContain(timelineMessages.askSubmitDone);
    expect(html).not.toContain(timelineMessages.askSubmitPending);
  });
});

const SIZES: IAskUserQuestionItem = {
  header: 'Sizes',
  question: 'Which sizes should we stock for the initial run?',
  multiSelect: true,
  options: [option('Small'), option('Medium'), option('Large')],
};

const ROLLOUT: IAskUserQuestionItem = {
  header: 'Rollout',
  question:
    'Should we roll this out to every workspace immediately, or stage it behind a flag '
    + 'for a week first so we can watch the error rate before committing?',
  multiSelect: false,
  options: [option('Immediately'), option('Staged')],
};

describe('AskUserQuestionItem — three questions with a multiSelect in the middle', () => {
  it('renders all three, including the long wrapping one', () => {
    const html = render(entry([COLOUR, SIZES, ROLLOUT]), 's1');

    for (const q of [COLOUR, SIZES, ROLLOUT]) {
      expect(html).toContain(q.header);
      for (const o of q.options) expect(html).toContain(o.label);
    }
  });

  it('refuses only the multiSelect question, leaving the others in the flow', () => {
    const html = render(entry([COLOUR, SIZES, ROLLOUT]), 's1');

    expect(html.match(new RegExp(timelineMessages.askMultiSelectTerminal, 'g'))).toHaveLength(1);
  });

  it('warns that a ☒ multiSelect may be only partly ticked before submitting', () => {
    const html = render(entry([COLOUR, SIZES, ROLLOUT]), 's1');

    expect(html).toContain(timelineMessages.askMultiSelectSubmitCaveat);
  });

  it('omits the caveat when no question is multiSelect', () => {
    const html = render(entry([COLOUR, ROLLOUT]), 's1');

    expect(html).not.toContain(timelineMessages.askMultiSelectSubmitCaveat);
  });
});

describe('AskUserQuestionItem — single-question prompt is unchanged', () => {
  it('renders one card with no submit step and no advisory notes', () => {
    const html = render(entry([COLOUR]), 's1');

    expect(html).toContain('Which colour?');
    expect(html).toContain('Red');
    expect(html.match(/<button/g)).toHaveLength(3);
    for (const key of [
      'askSubmitPending',
      'askSubmitDone',
      'askAwaitingQuestion',
      'askMultiSelectTerminal',
      'askMultiSelectSubmitCaveat',
    ] as const) {
      expect(html).not.toContain(timelineMessages[key]);
    }
  });

  it('keeps its options selectable as soon as a session is attached — no pane read required', () => {
    const live = render(entry([COLOUR]), 's1');
    const detached = render(entry([COLOUR]));

    expect(live).not.toContain('disabled');
    expect(detached.match(/<button[^>]*disabled/g)).toHaveLength(3);
  });

  it('marks the chosen option from the tool result', () => {
    const html = render(entry([COLOUR], { status: 'success', answer: 'Green' }), 's1');

    expect(html.match(/<button[^>]*disabled/g)).toHaveLength(3);
    expect(html).toContain('opacity-50');
  });

  it('routes a lone multiSelect question through the tabbed flow, which has a submit step', () => {
    const html = render(entry([{ ...COLOUR, multiSelect: true }]), 's1');

    expect(html).toContain(timelineMessages.askMultiSelectTerminal);
    expect(html).toContain(timelineMessages.askSubmitPending);
  });

  it('renders nothing when the parser produced no questions', () => {
    expect(render(entry([]), 's1')).toBe('');
  });
});
