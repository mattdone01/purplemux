import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ITimelineEntry } from '@/types/timeline';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');
const WORKSPACE_ID = 'ws-grok-timeline';
const SESSION_ID = '01a008c3-8e98-7220-a0d3-e0b36fa3aa99';

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
  const state: IFakeResponse = { statusCode: 0, body: undefined, res: undefined as unknown as NextApiResponse };
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  return state;
};

type THandler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const seedSession = async (grokHome: string, cwd = '/repo'): Promise<string> => {
  const dir = path.join(grokHome, 'sessions', encodeURIComponent(cwd), SESSION_ID);
  await fs.mkdir(dir, { recursive: true });
  for (const file of ['updates.jsonl', 'summary.json', 'signals.json']) {
    await fs.copyFile(path.join(FIXTURES, 'grok-session-tools', file), path.join(dir, file));
  }
  return path.join(dir, 'updates.jsonl');
};

describe('grok transcripts over the timeline routes', () => {
  let historyHandler: THandler;
  let entriesHandler: THandler;

  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-grok-timeline-'));
    await fs.mkdir(path.join(mockHome.value, '.grok'), { recursive: true });
    ({ default: historyHandler } = await import('@/pages/api/timeline/history'));
    ({ default: entriesHandler } = await import('@/pages/api/timeline/entries'));
  });

  const history = async (query: Record<string, string>): Promise<IFakeResponse> => {
    const response = fakeResponse();
    await historyHandler({ method: 'GET', query } as unknown as NextApiRequest, response.res);
    return response;
  };

  const entries = async (query: Record<string, string>): Promise<IFakeResponse> => {
    const response = fakeResponse();
    await entriesHandler({ method: 'GET', query } as unknown as NextApiRequest, response.res);
    return response;
  };

  it('resolves an unscoped session key to the transcript under ~/.grok', async () => {
    await seedSession(path.join(mockHome.value, '.grok'));

    const response = await history({ sessionKey: `grok:global:${SESSION_ID}` });
    const body = response.body as { entries: ITimelineEntry[]; nextSeq: number; hasMore: boolean };

    expect(response.statusCode).toBe(200);
    expect(body.entries[0]).toMatchObject({ type: 'user-message', seq: 0, id: `grok:${SESSION_ID}:0` });
    expect(body.hasMore).toBe(false);
    expect(body.nextSeq).toBe((body.entries[body.entries.length - 1].seq ?? 0) + 1);
  });

  it('resolves a workspace session key to the transcript under that GROK_HOME', async () => {
    const wsHome = path.join(mockHome.value, '.purplemux', 'workspaces', WORKSPACE_ID, 'grok-home');
    await seedSession(wsHome);

    const response = await history({ sessionKey: `grok:${WORKSPACE_ID}:${SESSION_ID}` });
    expect(response.statusCode).toBe(200);
    expect((response.body as { entries: ITimelineEntry[] }).entries.length).toBeGreaterThan(0);
  });

  it('pages forward from a cursor without repeating an entry', async () => {
    await seedSession(path.join(mockHome.value, '.grok'));

    const first = await history({ sessionKey: `grok:global:${SESSION_ID}`, limit: '4' });
    const firstBody = first.body as { entries: ITimelineEntry[]; nextSeq: number; hasMore: boolean };
    expect(firstBody.hasMore).toBe(true);

    const second = await history({
      sessionKey: `grok:global:${SESSION_ID}`,
      afterSeq: String(firstBody.nextSeq - 1),
    });
    const secondBody = second.body as { entries: ITimelineEntry[] };

    const firstSeqs = firstBody.entries.map((entry) => entry.seq);
    const secondSeqs = secondBody.entries.map((entry) => entry.seq);
    expect(firstSeqs.filter((seq) => secondSeqs.includes(seq))).toEqual([]);
    expect(Math.min(...secondSeqs.map((seq) => seq ?? 0))).toBeGreaterThan(Math.max(...firstSeqs.map((seq) => seq ?? 0)));
  });

  it('reports session-not-found for a grok id no home holds', async () => {
    const response = await history({ sessionKey: `grok:global:${SESSION_ID}` });
    expect(response).toMatchObject({ statusCode: 404, body: { error: 'session-not-found' } });
  });

  it('serves older entries from the ordinal cursor the init payload hands back', async () => {
    const jsonlPath = await seedSession(path.join(mockHome.value, '.grok'));

    const response = await entries({ jsonlPath, beforeByte: '4', limit: '2' });
    const body = response.body as { entries: ITimelineEntry[]; hasMore: boolean; replaceEntries: boolean };

    expect(response.statusCode).toBe(200);
    expect(body.entries.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(body.replaceEntries).toBe(false);
  });

  it('refuses a transcript path outside every grok home', async () => {
    const outside = path.join(mockHome.value, 'elsewhere', 'updates.jsonl');
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(outside, '');

    expect(await entries({ jsonlPath: outside, beforeByte: '4' }))
      .toMatchObject({ statusCode: 403 });
  });
});

describe('grok path validation', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = '/home/dev';
  });

  it('accepts an updates.jsonl in the unscoped home and in a workspace home', async () => {
    const { isAllowedJsonlPath, isGrokJsonlPath } = await import('@/lib/path-validation');

    const unscoped = `/home/dev/.grok/sessions/%2Frepo/${SESSION_ID}/updates.jsonl`;
    const scoped = `/home/dev/.purplemux/workspaces/${WORKSPACE_ID}/grok-home/sessions/%2Frepo/${SESSION_ID}/updates.jsonl`;

    expect(isGrokJsonlPath(unscoped)).toBe(true);
    expect(isGrokJsonlPath(scoped)).toBe(true);
    expect(isAllowedJsonlPath(unscoped)).toBe(true);
    expect(isAllowedJsonlPath(scoped)).toBe(true);
  });

  it('refuses a sibling file inside the session directory and anything outside the roots', async () => {
    const { isAllowedJsonlPath, isGrokJsonlPath } = await import('@/lib/path-validation');

    expect(isGrokJsonlPath(`/home/dev/.grok/sessions/%2Frepo/${SESSION_ID}/chat_history.jsonl`)).toBe(false);
    expect(isGrokJsonlPath('/home/dev/.grok-oss/sessions/x/updates.jsonl')).toBe(false);
    expect(isGrokJsonlPath(`/home/dev/.grok/sessions/../../../etc/${SESSION_ID}/updates.jsonl`)).toBe(false);
    expect(isAllowedJsonlPath('/home/dev/.grok-oss/sessions/x/updates.jsonl')).toBe(false);
  });
});
