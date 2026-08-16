import fs from 'fs/promises';
import type { NextApiRequest, NextApiResponse } from 'next';
import { listAllCodexSessions } from '@/lib/codex-session-list';
import { parseSessionMeta } from '@/lib/session-list';
import { buildSessionKey, GLOBAL_SESSION_SCOPE } from '@/lib/session-key';
import { listClaudeTranscripts, type TSessionProvider } from '@/lib/session-resolver';
import { listSessionScopes, sessionScopeFor, type ISessionScope } from '@/lib/session-scope';
import { readLastSeq } from '@/lib/timeline-history';

export const DEFAULT_SESSION_LIMIT = 200;
export const MAX_SESSION_LIMIT = 500;

export interface ISessionSummary {
  sessionKey: string;
  provider: TSessionProvider;
  workspaceId: string | null;
  startedAt: string;
  lastActivityAt: string;
  firstMessage: string;
  turnCount: number;
  lastSeq: number;
}

export interface ISessionsPage {
  sessions: ISessionSummary[];
  total: number;
  hasMore: boolean;
}

export interface ISessionsQuery {
  workspaceId: string | null;
  limit: number;
  offset: number;
}

export type TSessionsQueryResult =
  | { ok: true; query: ISessionsQuery }
  | { ok: false; error: 'bad-request' };

interface ICandidate {
  provider: TSessionProvider;
  sessionId: string;
  jsonlPath: string;
  lastActivityMs: number;
  /** Working directory the session was started in; null for the Claude store. */
  cwd: string | null;
  /** Codex listing already carries meta; Claude candidates parse theirs per page. */
  codex?: { startedAt: number; firstMessage: string; turnCount: number };
}

const WORKSPACE_ID = /^[A-Za-z0-9._-]+$/;

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

const parseInteger = (value: string | undefined, fallback: number): number | null => {
  if (value === undefined || value === '') return fallback;
  if (!/^-?\d+$/.test(value)) return null;
  return Number(value);
};

export const parseSessionsQuery = (query: NextApiRequest['query']): TSessionsQueryResult => {
  const scope = single(query.workspaceId);
  if (!scope) return { ok: false, error: 'bad-request' };
  if (scope !== GLOBAL_SESSION_SCOPE && !WORKSPACE_ID.test(scope)) {
    return { ok: false, error: 'bad-request' };
  }

  const limit = parseInteger(single(query.limit), DEFAULT_SESSION_LIMIT);
  if (limit === null || limit < 1) return { ok: false, error: 'bad-request' };

  const offset = parseInteger(single(query.offset), 0);
  if (offset === null || offset < 0) return { ok: false, error: 'bad-request' };

  return {
    ok: true,
    query: {
      workspaceId: scope === GLOBAL_SESSION_SCOPE ? null : scope,
      limit: Math.min(limit, MAX_SESSION_LIMIT),
      offset,
    },
  };
};

const claudeCandidates = async (workspaceId: string | null): Promise<ICandidate[]> => {
  const transcripts = await listClaudeTranscripts(workspaceId);
  const candidates = await Promise.all(
    transcripts.map(async ({ sessionId, jsonlPath }): Promise<ICandidate | null> => {
      try {
        const stat = await fs.stat(jsonlPath);
        return { provider: 'claude', sessionId, jsonlPath, lastActivityMs: stat.mtimeMs, cwd: null };
      } catch {
        return null;
      }
    }),
  );
  return candidates.filter((candidate): candidate is ICandidate => candidate !== null);
};

// Codex keys its rollouts by cwd, not by workspace. Membership is decided by the
// same derivation that builds the sessionKey, so a session this route lists is a
// session whose key names this workspace — including one started in a
// SUBDIRECTORY of a workspace root, which search has always attributed here.
const codexCandidates = async (
  workspaceId: string | null,
  scopes: ISessionScope[],
): Promise<ICandidate[]> => {
  const byPath = new Map<string, ICandidate>();

  for (const entry of await listAllCodexSessions()) {
    if (byPath.has(entry.jsonlPath)) continue;
    const scope = sessionScopeFor({ provider: 'codex', scopes, cwd: entry.cwd });
    if (scope.workspaceId !== workspaceId) continue;
    byPath.set(entry.jsonlPath, {
      provider: 'codex',
      sessionId: entry.sessionId,
      jsonlPath: entry.jsonlPath,
      lastActivityMs: entry.lastActivityAt,
      cwd: entry.cwd,
      codex: {
        startedAt: entry.startedAt,
        firstMessage: entry.firstUserMessage ?? '',
        turnCount: entry.turnCount,
      },
    });
  }
  return [...byPath.values()];
};

const summarize = async (
  candidate: ICandidate,
  workspaceId: string | null,
  scopes: ISessionScope[],
): Promise<ISessionSummary | null> => {
  const scope = sessionScopeFor({
    provider: candidate.provider,
    scopes,
    workspaceId,
    cwd: candidate.cwd,
  });
  const sessionKey = buildSessionKey({
    provider: candidate.provider,
    workspaceId: scope.workspaceId,
    sessionId: candidate.sessionId,
  });
  const lastSeq = await readLastSeq(candidate.jsonlPath, candidate.provider);

  if (candidate.codex) {
    return {
      sessionKey,
      provider: candidate.provider,
      workspaceId,
      startedAt: new Date(candidate.codex.startedAt).toISOString(),
      lastActivityAt: new Date(candidate.lastActivityMs).toISOString(),
      firstMessage: candidate.codex.firstMessage,
      turnCount: candidate.codex.turnCount,
      lastSeq,
    };
  }

  const meta = await parseSessionMeta(candidate.jsonlPath);
  if (!meta) return null;

  return {
    sessionKey,
    provider: candidate.provider,
    workspaceId,
    startedAt: meta.startedAt,
    lastActivityAt: meta.lastActivityAt,
    firstMessage: meta.firstMessage,
    turnCount: meta.turnCount,
    lastSeq,
  };
};

/**
 * Ordering and paging run on cheap stat/listing data; only the requested page
 * pays for a transcript scan.
 */
export const listSessionsV2 = async ({
  workspaceId,
  limit,
  offset,
}: ISessionsQuery): Promise<ISessionsPage> => {
  const scopes = await listSessionScopes();
  const [claude, codex] = await Promise.all([
    claudeCandidates(workspaceId),
    codexCandidates(workspaceId, scopes),
  ]);

  const candidates = [...claude, ...codex].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  const page = candidates.slice(offset, offset + limit);
  const summaries = await Promise.all(page.map((candidate) => summarize(candidate, workspaceId, scopes)));
  const sessions = summaries.filter((session): session is ISessionSummary => session !== null);

  return {
    sessions,
    total: candidates.length,
    hasMore: offset + page.length < candidates.length,
  };
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = parseSessionsQuery(req.query);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  return res.status(200).json(await listSessionsV2(parsed.query));
};

export default handler;
