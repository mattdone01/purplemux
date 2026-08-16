import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

const WORKSPACE_ID = 'ws-listing';
const WORKSPACE_DIR = '/tmp/pmux-listing-project';

interface ISessionRow {
  sessionKey: string;
  provider: string;
  workspaceId: string | null;
  startedAt: string;
  lastActivityAt: string;
  firstMessage: string;
  turnCount: number;
  lastSeq: number;
}

interface ISessionsBody {
  sessions: ISessionRow[];
  total: number;
  hasMore: boolean;
}

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

const claudeLines = (sessionId: string, count: number): string =>
  `${Array.from({ length: count }, (_, i) => JSON.stringify({
    uuid: `${sessionId}-${i}`,
    sessionId,
    timestamp: `2026-08-16T00:00:0${i % 10}.000Z`,
    type: 'user',
    message: { role: 'user', content: `message ${i} of ${sessionId}` },
  })).join('\n')}\n`;

const writeClaudeSession = async (
  projectsRoot: string,
  sessionId: string,
  { lines = 3, mtimeSeconds }: { lines?: number; mtimeSeconds: number },
): Promise<string> => {
  const dir = path.join(projectsRoot, '-tmp-pmux-listing-project');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await fs.writeFile(file, claudeLines(sessionId, lines), 'utf-8');
  await fs.utimes(file, mtimeSeconds, mtimeSeconds);
  return file;
};

const writeCodexSession = async (
  home: string,
  sessionId: string,
  { cwd, mtimeSeconds }: { cwd: string; mtimeSeconds: number },
): Promise<string> => {
  const now = new Date();
  const dayDir = path.join(
    home, '.codex', 'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  await fs.mkdir(dayDir, { recursive: true });
  const file = path.join(dayDir, `rollout-2026-08-16T00-00-00-${sessionId}.jsonl`);
  await fs.writeFile(file, [
    JSON.stringify({
      timestamp: '2026-08-16T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, timestamp: '2026-08-16T00:00:00.000Z', cwd },
    }),
    JSON.stringify({
      timestamp: '2026-08-16T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: `codex work in ${cwd}` },
    }),
    JSON.stringify({
      timestamp: '2026-08-16T00:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'on it' },
    }),
  ].join('\n') + '\n', 'utf-8');
  await fs.utimes(file, mtimeSeconds, mtimeSeconds);
  return file;
};

const writeWorkspaces = async (home: string, directories: string[]): Promise<void> => {
  const dir = path.join(home, '.purplemux');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'workspaces.json'),
    JSON.stringify({ workspaces: [{ id: WORKSPACE_ID, name: 'Listing', directories }] }),
    'utf-8',
  );
};

type THandler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

describe('GET /api/timeline/sessions-v2', () => {
  let home: string;
  let workspaceProjects: string;
  let globalProjects: string;
  let handler: THandler;

  const call = async (query: Record<string, string>): Promise<IFakeResponse> => {
    const response = fakeResponse();
    await handler({ method: 'GET', query } as unknown as NextApiRequest, response.res);
    return response;
  };

  const list = async (query: Record<string, string>): Promise<ISessionsBody> => {
    const response = await call(query);
    expect(response.statusCode).toBe(200);
    return response.body as ISessionsBody;
  };

  beforeEach(async () => {
    vi.resetModules();
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-sessions-v2-'));
    mockHome.value = home;
    workspaceProjects = path.join(home, '.purplemux', 'workspaces', WORKSPACE_ID, 'claude-home', 'projects');
    globalProjects = path.join(home, '.claude', 'projects');
    await writeWorkspaces(home, [WORKSPACE_DIR]);
    ({ default: handler } = await import('@/pages/api/timeline/sessions-v2'));
  });

  it('lists a workspace claude-home and its Codex sessions, newest first', async () => {
    await writeClaudeSession(workspaceProjects, 'claude-old', { mtimeSeconds: 1_000 });
    await writeClaudeSession(workspaceProjects, 'claude-new', { mtimeSeconds: 3_000 });
    await writeCodexSession(home, 'codex-mid', { cwd: WORKSPACE_DIR, mtimeSeconds: 2_000 });
    await writeCodexSession(home, 'codex-elsewhere', { cwd: '/tmp/other-project', mtimeSeconds: 4_000 });

    const body = await list({ workspaceId: WORKSPACE_ID });

    expect(body.sessions.map((session) => session.sessionKey)).toEqual([
      `claude:${WORKSPACE_ID}:claude-new`,
      `codex:${WORKSPACE_ID}:codex-mid`,
      `claude:${WORKSPACE_ID}:claude-old`,
    ]);
    expect(body.total).toBe(3);
    expect(body.hasMore).toBe(false);
    expect(body.sessions.every((session) => session.workspaceId === WORKSPACE_ID)).toBe(true);
  });

  it('carries the fields the mobile cache keys on', async () => {
    await writeClaudeSession(workspaceProjects, 'claude-meta', { lines: 4, mtimeSeconds: 1_000 });
    await writeCodexSession(home, 'codex-meta', { cwd: WORKSPACE_DIR, mtimeSeconds: 2_000 });

    const { sessions } = await list({ workspaceId: WORKSPACE_ID });
    const codex = sessions.find((session) => session.provider === 'codex');
    const claude = sessions.find((session) => session.provider === 'claude');

    expect(claude).toMatchObject({
      sessionKey: `claude:${WORKSPACE_ID}:claude-meta`,
      provider: 'claude',
      firstMessage: 'message 0 of claude-meta',
      turnCount: 4,
    });
    expect(Number.isNaN(Date.parse(claude!.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(claude!.lastActivityAt))).toBe(false);
    expect(codex).toMatchObject({ sessionKey: `codex:${WORKSPACE_ID}:codex-meta`, provider: 'codex' });
    expect(codex!.firstMessage).toContain('codex work in');
  });

  it('reports a lastSeq the history cursor can be compared against', async () => {
    await writeClaudeSession(workspaceProjects, 'claude-seq', { lines: 6, mtimeSeconds: 1_000 });
    const { default: history } = await import('@/pages/api/timeline/history');

    const { sessions } = await list({ workspaceId: WORKSPACE_ID });
    const response = fakeResponse();
    await history(
      { method: 'GET', query: { sessionKey: sessions[0].sessionKey, afterSeq: '-1' } } as unknown as NextApiRequest,
      response.res,
    );
    const { entries } = response.body as { entries: { seq?: number }[] };

    expect(entries).toHaveLength(6);
    expect(sessions[0].lastSeq).toBe(entries[5].seq);

    const caughtUp = await list({ workspaceId: WORKSPACE_ID });
    expect(caughtUp.sessions[0].lastSeq).toBeLessThanOrEqual(entries[5].seq!);
  });

  it('lists a codex session started in a SUBDIRECTORY of a workspace root', async () => {
    await writeCodexSession(home, 'codex-nested', {
      cwd: path.join(WORKSPACE_DIR, 'packages', 'api'),
      mtimeSeconds: 2_000,
    });

    const body = await list({ workspaceId: WORKSPACE_ID });

    expect(body.sessions.map((session) => session.sessionKey)).toEqual([`codex:${WORKSPACE_ID}:codex-nested`]);
    expect(body.sessions[0].workspaceId).toBe(WORKSPACE_ID);
  });

  it('gives a subdirectory codex session the same key /api/timeline/search does', async () => {
    await writeCodexSession(home, 'codex-shared', {
      cwd: path.join(WORKSPACE_DIR, 'packages', 'api'),
      mtimeSeconds: 2_000,
    });

    const { sessions } = await list({ workspaceId: WORKSPACE_ID });
    const { default: search } = await import('@/pages/api/timeline/search');
    const response = fakeResponse();
    await search(
      { method: 'GET', query: { q: 'codex work' } } as unknown as NextApiRequest,
      response.res,
    );
    const { hits } = response.body as { hits: { sessionKey: string }[] };

    expect(sessions).toHaveLength(1);
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((hit) => hit.sessionKey))).toEqual(new Set([sessions[0].sessionKey]));
  });

  it('keys a codex session under no workspace directory global, in the scope that lists it', async () => {
    await writeCodexSession(home, 'codex-loose', { cwd: '/tmp/unclaimed-project', mtimeSeconds: 2_000 });

    const scoped = await list({ workspaceId: WORKSPACE_ID });
    const global = await list({ workspaceId: 'global' });

    expect(scoped.sessions.map((session) => session.sessionKey)).toEqual([]);
    expect(global.sessions.map((session) => session.sessionKey)).toEqual(['codex:global:codex-loose']);
  });

  it('lists ~/.claude sessions for the global scope and keys them global', async () => {
    await writeClaudeSession(globalProjects, 'global-session', { mtimeSeconds: 1_000 });
    await writeClaudeSession(workspaceProjects, 'scoped-session', { mtimeSeconds: 2_000 });

    const body = await list({ workspaceId: 'global' });

    expect(body.sessions.map((session) => session.sessionKey)).toEqual(['claude:global:global-session']);
    expect(body.sessions[0].workspaceId).toBeNull();
  });

  it('pages with limit and offset and reports total and hasMore', async () => {
    for (let i = 0; i < 5; i++) {
      await writeClaudeSession(workspaceProjects, `claude-${i}`, { mtimeSeconds: 1_000 + i });
    }

    const first = await list({ workspaceId: WORKSPACE_ID, limit: '2' });
    const second = await list({ workspaceId: WORKSPACE_ID, limit: '2', offset: '2' });
    const last = await list({ workspaceId: WORKSPACE_ID, limit: '2', offset: '4' });

    expect(first.sessions.map((s) => s.sessionKey)).toEqual([
      `claude:${WORKSPACE_ID}:claude-4`,
      `claude:${WORKSPACE_ID}:claude-3`,
    ]);
    expect(first).toMatchObject({ total: 5, hasMore: true });
    expect(second.sessions.map((s) => s.sessionKey)).toEqual([
      `claude:${WORKSPACE_ID}:claude-2`,
      `claude:${WORKSPACE_ID}:claude-1`,
    ]);
    expect(second.hasMore).toBe(true);
    expect(last.sessions).toHaveLength(1);
    expect(last.hasMore).toBe(false);
  });

  it('returns an empty page for a workspace with no claude-home', async () => {
    const body = await list({ workspaceId: 'ws-never-created' });

    expect(body).toEqual({ sessions: [], total: 0, hasMore: false });
  });

  it('rejects a missing or unsafe workspaceId and a non-GET method', async () => {
    await expect(call({})).resolves.toMatchObject({ statusCode: 400, body: { error: 'bad-request' } });
    await expect(call({ workspaceId: '../../etc' })).resolves.toMatchObject({ statusCode: 400 });
    await expect(call({ workspaceId: WORKSPACE_ID, limit: '0' })).resolves.toMatchObject({ statusCode: 400 });
    await expect(call({ workspaceId: WORKSPACE_ID, offset: '-1' })).resolves.toMatchObject({ statusCode: 400 });

    const response = fakeResponse();
    await handler({ method: 'POST', query: {} } as unknown as NextApiRequest, response.res);
    expect(response.statusCode).toBe(405);
  });
});
