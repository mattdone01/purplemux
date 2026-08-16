import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const tmux = vi.hoisted(() => ({ hasSession: vi.fn(async () => true) }));
const capture = vi.hoisted(() => ({ capturePaneAtWidth: vi.fn(async () => '' as string | null) }));

vi.mock('@/lib/tmux', () => tmux);
vi.mock('@/lib/capture-at-width', () => capture);
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }));

const { default: handler } = await import('@/pages/api/tmux/ask-question-state');

interface IStateBody {
  phase: string;
  activeIndex: number;
  answered: boolean[];
  complete: boolean;
  options: string[];
}

interface IFakeResponse {
  statusCode: number;
  body: IStateBody;
  headers: Record<string, string>;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
  const state: IFakeResponse = {
    statusCode: 0,
    body: {} as IStateBody,
    headers: {},
    res: undefined as unknown as NextApiResponse,
  };
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload as IStateBody;
      return this;
    },
    setHeader(key: string, value: string) {
      state.headers[key] = value;
    },
  } as unknown as NextApiResponse;
  return state;
};

// The tool input the captured session was driven with.
const QUESTIONS = [
  { header: 'Colour', question: 'Which colour?', multiSelect: false, options: [] },
  { header: 'Size', question: 'Which size?', multiSelect: false, options: [] },
];

const call = async (body: unknown, method = 'POST') => {
  const res = fakeResponse();
  await handler({ method, body } as NextApiRequest, res.res);
  return res;
};

// A real capture, not a reconstruction: question 1 answered, question 2 live.
const PANE = readFileSync(
  join(__dirname, '../../fixtures/ask-user-question/04-after-digit-2.txt'),
  'utf8',
);

beforeEach(() => {
  tmux.hasSession.mockReset().mockResolvedValue(true);
  capture.capturePaneAtWidth.mockReset().mockResolvedValue(PANE);
});

describe('POST /api/tmux/ask-question-state', () => {
  it('reports the live question index read from the pane', async () => {
    const res = await call({ session: 's1', questions: QUESTIONS });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      phase: 'question',
      activeIndex: 1,
      answered: [true, false],
      complete: false,
      options: ['1. Small', '2. Large', '3. Type something.', '4. Chat about this'],
    });
    expect(capture.capturePaneAtWidth).toHaveBeenCalledWith('s1', 120, 50);
  });

  it('rejects a non-POST method', async () => {
    const res = await call({ session: 's1', questions: QUESTIONS }, 'GET');

    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST');
  });

  it('requires a session and a question list', async () => {
    expect((await call({ questions: QUESTIONS })).statusCode).toBe(400);
    expect((await call({ session: 's1' })).statusCode).toBe(400);
    expect((await call({ session: 's1', questions: [] })).statusCode).toBe(400);
  });

  it('404s when the session is gone so the UI can point at the terminal', async () => {
    tmux.hasSession.mockResolvedValue(false);

    const res = await call({ session: 's1', questions: QUESTIONS });

    expect(res.statusCode).toBe(404);
  });

  it('reports unavailable — not absent — when the pane cannot be captured', async () => {
    capture.capturePaneAtWidth.mockResolvedValue(null);

    const res = await call({ session: 's1', questions: QUESTIONS });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ phase: 'unavailable', activeIndex: -1, complete: false });
  });

  it('500s when the capture itself throws', async () => {
    capture.capturePaneAtWidth.mockRejectedValue(new Error('tmux gone'));

    const res = await call({ session: 's1', questions: QUESTIONS });

    expect(res.statusCode).toBe(500);
  });

  it('coerces malformed question entries instead of dropping them, so indices stay aligned', async () => {
    const res = await call({
      session: 's1',
      questions: [{ header: 'Colour', question: 'Which colour?' }, null, 7],
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.answered).toHaveLength(3);
  });

  it('reports the complete Submit tab so the caller knows a submit step is due', async () => {
    capture.capturePaneAtWidth.mockResolvedValue(
      readFileSync(join(__dirname, '../../fixtures/ask-user-question/05-after-last-answer.txt'), 'utf8'),
    );

    const res = await call({ session: 's1', questions: QUESTIONS });

    expect(res.body).toMatchObject({
      phase: 'submit',
      activeIndex: 2,
      complete: true,
      options: ['1. Submit answers', '2. Cancel'],
    });
  });
});

describe('POST /api/tmux/ask-question-state — three questions', () => {
  const THREE = [
    { header: 'Colour', question: 'Which colour?', multiSelect: false, options: [] },
    { header: 'Sizes', question: 'Which sizes should we stock for the initial run?', multiSelect: true, options: [] },
    {
      header: 'Rollout',
      question:
        'Should we roll this out to every workspace immediately, or stage it behind a flag '
        + 'for a week first so we can watch the error rate before committing?',
      multiSelect: false,
      options: [],
    },
  ];

  const withPane = async (name: string) => {
    capture.capturePaneAtWidth.mockResolvedValue(
      readFileSync(join(__dirname, `../../fixtures/ask-user-question/${name}.txt`), 'utf8'),
    );
    return call({ session: 's1', questions: THREE });
  };

  it('reports the multiSelect tab as ☒ after one toggle without calling the form complete', async () => {
    const res = await withPane('09-multiselect-after-digit');

    expect(res.body).toMatchObject({
      phase: 'question',
      activeIndex: 1,
      answered: [false, true, false],
      complete: false,
    });
  });

  it('reports absent after Escape cancels the prompt', async () => {
    const res = await withPane('10-after-escape');

    expect(res.body).toMatchObject({ phase: 'absent', activeIndex: -1 });
  });
});

describe('POST /api/tmux/ask-question-state — the widest prompt the schema allows', () => {
  const FOUR = [
    { header: 'Configuratn', question: 'Config?', multiSelect: false, options: [] },
    { header: 'Environmnts', question: 'Env?', multiSelect: true, options: [] },
    { header: 'Deploymentz', question: 'Deploy?', multiSelect: false, options: [] },
    { header: 'Monitoringx', question: 'Monitor?', multiSelect: false, options: [] },
  ];

  it('serves a complete four-question Submit tab, multiSelect answer included', async () => {
    capture.capturePaneAtWidth.mockResolvedValue(
      readFileSync(join(__dirname, '../../fixtures/ask-user-question/12-submit-with-multiselect.txt'), 'utf8'),
    );

    const res = await call({ session: 's1', questions: FOUR });

    expect(res.body).toMatchObject({
      phase: 'submit',
      activeIndex: 4,
      answered: [true, true, true, true],
      complete: true,
    });
  });
});
