import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISpendView } from '@/types/spend';
import type { IMissionBurndownResponse } from '@/types/burndown';

const mockHome = vi.hoisted(() => ({ value: '' }));
const auth = vi.hoisted(() => ({ allow: true, human: true, asked: [] as string[] }));
const portfolio = vi.hoisted(() => ({ selection: null as null | { managerWorkspaceId: string } }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/cli-utils', () => ({
  authorizeWorkspace: async (_req: unknown, res: NextApiResponse, workspaceId: string) => {
    auth.asked.push(workspaceId);
    if (auth.allow) return { type: 'workspace', workspaceId };
    res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    return null;
  },
}));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: async () => ({ workspaces: [
    { id: 'ws-a', name: 'Alpha', orchestration: { enabled: true, orchestratorTabId: 'tab-orch' } },
    { id: 'ws-b', name: 'Beta' },
  ], groups: [] }),
}));
vi.mock('@/lib/auth', async (original) => ({ ...await original<typeof import('@/lib/auth')>(),
  verifySessionToken: vi.fn(async () => (auth.human ? { sub: 'human' } : null)),
}));
vi.mock('@/lib/portfolio-store', () => ({
  getPortfolioStore: () => ({
    currentSelection: () => portfolio.selection && { actor: 'human', updatedAt: 1,
      selection: { ...portfolio.selection, managerTabId: 'tab-orch', workspaceIds: [] } },
  }),
}));

const DAY = 86_400_000;
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const TODAY = utc(Date.now());

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, unknown> };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader(name: string, value: unknown) { state.headers[name] = value; return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const cliCall = async (query: Record<string, string>, method = 'GET') => {
  const { default: handler } = await import('@/pages/api/cli/spend');
  const { state, res } = fakeResponse();
  await handler({ method, query, headers: { 'x-pmux-token': 't' } } as unknown as NextApiRequest, res);
  return state;
};

const missionCall = async (query: Record<string, string>, cookie = true) => {
  const { default: handler } = await import('@/pages/api/mission-control/spend');
  const { state, res } = fakeResponse();
  await handler({ method: 'GET', query, headers: cookie ? { cookie: 'session-token=t' } : { 'x-pmux-token': 't' } } as unknown as NextApiRequest, res);
  return state;
};

const assistant = (id: string, session: string, day: string, input = 10) => JSON.stringify({
  type: 'assistant', timestamp: `${day}T12:00:00.000Z`, sessionId: session,
  message: { id, model: 'claude-opus-4-6', usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

const seedTranscripts = async () => {
  const projects = (ws: string) => path.join(mockHome.value, '.purplemux', 'workspaces', ws, 'claude-home', 'projects', '-p');
  await fs.mkdir(projects('ws-a'), { recursive: true });
  await fs.mkdir(projects('ws-b'), { recursive: true });
  await fs.writeFile(path.join(projects('ws-a'), 's-orch.jsonl'), `${assistant('m1', 's-orch', TODAY, 100)}\n${assistant('m2', 's-orch', utc(Date.now() - 10 * DAY), 7)}\n`);
  await fs.writeFile(path.join(projects('ws-a'), 's-free.jsonl'), `${assistant('m3', 's-free', TODAY, 30)}\n`);
  await fs.writeFile(path.join(projects('ws-b'), 's-b.jsonl'), `${assistant('m4', 's-b', TODAY, 5)}\n`);
  await fs.mkdir(path.join(mockHome.value, '.purplemux'), { recursive: true });
  await fs.writeFile(path.join(mockHome.value, '.purplemux', 'session-tabs.json'), JSON.stringify({ version: 1, bindings: {
    'claude:s-orch': { workspaceId: 'ws-a', tabId: 'tab-orch', firstSeenAt: 1, lastSeenAt: Date.now() },
  } }));
  const index = await import('@/lib/spend/spend-index');
  await index.runSpendIndexPass();
  return index;
};

const resetGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['__ptSpendIndexer', '__ptSpendIndexWriteLock', '__ptCodexStatsCache', '__ptSessionTabsSeen', '__ptSessionTabsRefusedAt']) delete g[key];
};

describe('spend routes', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-spend-api-'));
    auth.allow = true;
    auth.human = true;
    auth.asked = [];
    portfolio.selection = null;
    process.env.NEXTAUTH_SECRET = 'spend-route-test-secret-at-least-32-bytes-long';
  });
  afterEach(async () => {
    resetGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  describe('GET /api/cli/spend', () => {
    it('answers the last 7 UTC days by tab with the sum invariant and the unattributed row', async () => {
      await seedTranscripts();
      const result = await cliCall({ workspaceId: 'ws-a' });
      expect(result.statusCode).toBe(200);
      expect(result.headers['Cache-Control']).toBe('no-store');
      const view = result.body as ISpendView;
      expect(view).toMatchObject({ workspaceId: 'ws-a', from: utc(Date.now() - 6 * DAY), to: TODAY, by: 'tab' });
      expect(view.rows).toEqual([expect.objectContaining({ key: 'tab-orch', totalTokens: 100 })]);
      expect(view.unattributed).toMatchObject({ totalTokens: 30 });
      expect(view.totals.totalTokens).toBe(130);
      expect(view.index.state).toBe('ready');
      expect(auth.asked).toEqual(['ws-a']);
    });

    it('takes since, until and by', async () => {
      await seedTranscripts();
      const view = (await cliCall({ workspaceId: 'ws-a', since: utc(Date.now() - 30 * DAY), until: TODAY, by: 'role' })).body as ISpendView;
      expect(view.roleBasis).toBe('current-orchestrator');
      expect(view.rows).toEqual([expect.objectContaining({ key: 'orchestrator', totalTokens: 107 })]);
    });

    it.each([
      [{ since: '2026-02-30' }, 'since: saw "2026-02-30", expected a UTC day YYYY-MM-DD'],
      [{ until: 'today' }, 'until: saw "today"'],
      [{ since: '2026-01-01', until: '2026-06-01' }, 'range: saw 152 days, expected at most 92'],
      [{ since: '2026-02-02', until: '2026-02-01' }, 'since 2026-02-02 is after until 2026-02-01'],
      [{ by: 'workspace' }, 'by: saw "workspace", expected one of tab, day, model, role'],
      [{ by: 'toString' }, 'by: saw "toString"'],
    ])('refuses %o with invalid-request', async (query, message) => {
      const result = await cliCall({ workspaceId: 'ws-a', ...query });
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatchObject({ code: 'invalid-request', error: expect.stringContaining(message) });
    });

    it('serves the 92 UTC days from the spend floor and refuses a day before it', async () => {
      expect((await cliCall({ workspaceId: 'ws-a', since: utc(Date.now() - 91 * DAY) })).statusCode).toBe(200);
      const before = utc(Date.now() - 92 * DAY);
      const refused = await cliCall({ workspaceId: 'ws-a', since: before, until: before });
      expect(refused.statusCode).toBe(400);
      expect(refused.body).toEqual({ code: 'invalid-request', error: `Invalid spend request: since: saw ${before}, expected a day on or after ${utc(Date.now() - 91 * DAY)} (spend keeps the last 92 UTC days)` });
    });

    it('needs a workspace in read scope that exists, and GET only', async () => {
      expect((await cliCall({})).body).toMatchObject({ code: 'invalid-request' });
      auth.allow = false;
      expect((await cliCall({ workspaceId: 'ws-b' })).statusCode).toBe(403);
      auth.allow = true;
      expect((await cliCall({ workspaceId: 'ws-gone' })).body).toMatchObject({ code: 'not-found' });
      expect((await cliCall({ workspaceId: 'ws-a' }, 'POST')).statusCode).toBe(405);
    });

    it('parses no transcript on a request (NFR-7)', async () => {
      const index = await seedTranscripts();
      const parsed = index.spendIndexParseCount();
      await cliCall({ workspaceId: 'ws-a' });
      await cliCall({ workspaceId: 'ws-a', by: 'day' });
      expect(index.spendIndexParseCount()).toBe(parsed);
    });

    it('reports a damaged binding store and attributes nothing to a tab', async () => {
      await seedTranscripts();
      await fs.writeFile(path.join(mockHome.value, '.purplemux', 'session-tabs.json'), 'nope');
      const view = (await cliCall({ workspaceId: 'ws-a' })).body as ISpendView;
      expect(view.rows).toEqual([]);
      expect(view.unattributed?.totalTokens).toBe(130);
      expect(view.index.error).toContain('session-tabs.json unreadable');
    });

    it('answers indexing before the first pass', async () => {
      const view = (await cliCall({ workspaceId: 'ws-a' })).body as ISpendView;
      expect(view.index).toMatchObject({ state: 'indexing', filesIndexed: 0 });
      expect(view.totals.costUsd).toBeNull();
    });
  });

  describe('GET /api/mission-control/spend', () => {
    it('refuses a CLI token without a session with 401', async () => {
      auth.human = false;
      const result = await missionCall({ workspaceId: 'ws-a' }, false);
      expect(result.statusCode).toBe(401);
      expect(result.body).toMatchObject({ code: 'unauthorized' });
    });

    it('answers the same view the CLI route answers for the same range', async () => {
      await seedTranscripts();
      const human = (await missionCall({ workspaceId: 'ws-a', period: '7d' })).body as ISpendView;
      const cli = (await cliCall({ workspaceId: 'ws-a' })).body as ISpendView;
      expect({ ...human, generatedAt: 0 }).toEqual({ ...cli, generatedAt: 0 });
    });

    it('answers today, and every workspace by workspace', async () => {
      await seedTranscripts();
      const today = (await missionCall({ workspaceId: 'ws-a', period: 'today' })).body as ISpendView;
      expect(today).toMatchObject({ from: TODAY, to: TODAY });
      const all = await missionCall({ workspaceId: 'all', period: '30d', by: 'workspace' });
      expect(all.headers['Cache-Control']).toBe('no-store');
      const view = all.body as ISpendView;
      expect(view.workspaceId).toBe('all');
      expect(view.rows.map((row) => [row.key, row.label, row.totalTokens])).toEqual([['ws-a', 'Alpha', 137], ['ws-b', 'Beta', 5]]);
    });

    it.each([
      [{ workspaceId: 'ws-a', by: 'workspace' }, 'by=workspace needs workspaceId=all'],
      [{ workspaceId: 'ws-a', period: '90d' }, 'period: saw "90d"'],
      [{ workspaceId: 'ws-gone' }, 'workspace ws-gone does not exist'],
      [{}, 'workspaceId is required'],
    ])('refuses %o with invalid-request', async (query, message) => {
      const result = await missionCall(query);
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatchObject({ code: 'invalid-request', error: expect.stringContaining(message) });
    });
  });

  describe('GET /api/mission-control/burndown tokensByDay', () => {
    const missionBurndown = async () => {
      const { default: handler } = await import('@/pages/api/mission-control/burndown');
      const { state, res } = fakeResponse();
      await handler({ method: 'GET', query: {}, headers: { cookie: 'session-token=t' } } as unknown as NextApiRequest, res);
      return state.body as IMissionBurndownResponse;
    };
    const publish = async (firstAt: string) => {
      const { writeBurndown } = await import('@/lib/burndown-store');
      await writeBurndown({ workspaceId: 'ws-a', receivedAt: Date.now(), snapshot: { generated_at: `${TODAY}T00:00:00Z`, epics: [],
        history: [{ at: firstAt, slug: 'e', total: 1, burned: 0, remaining: 1, pct: 0, stories: 1, unpointed: 0 }] } });
    };

    it('adds one tokens figure per day of the chart once the index is ready', async () => {
      portfolio.selection = { managerWorkspaceId: 'ws-a' };
      await seedTranscripts();
      await publish(`${utc(Date.now() - 2 * DAY)}T08:00:00Z`);
      const body = await missionBurndown();
      expect(body.tokensByDay).toEqual([
        { day: utc(Date.now() - 2 * DAY), totalTokens: 0, sidechainTokens: 0 },
        { day: utc(Date.now() - DAY), totalTokens: 0, sidechainTokens: 0 },
        { day: TODAY, totalTokens: 130, sidechainTokens: 0 },
      ]);
    });

    it('leaves the field out while the index is still building, and without a burndown', async () => {
      portfolio.selection = { managerWorkspaceId: 'ws-a' };
      expect(await missionBurndown()).toEqual({ workspaceId: 'ws-a', burndown: null });
      await publish(`${TODAY}T08:00:00Z`);
      expect('tokensByDay' in await missionBurndown()).toBe(false);
    });
  });
});
