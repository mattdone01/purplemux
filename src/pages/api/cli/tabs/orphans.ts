import type { NextApiRequest, NextApiResponse } from 'next';
import { isOwnWorkspace, selectedScrumMasterMayMutate } from '@/lib/cli-utils';
import { requireCaller } from '@/lib/lease-http';
import { createLogger } from '@/lib/logger';
import { OrphanSweepError, sweepOrphans, type TMayReap } from '@/lib/tab-orphans-service';
import { resolveCliScope } from '@/lib/workspace-token';

const log = createLogger('terminal');

const hostOf = (raw: unknown): string | undefined | null => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return typeof raw === 'string' ? raw : null;
};

/**
 * `purplemux tab orphans [--host H] [--reap]`. GET lists, for any caller. POST `{ reap: true }` reaps kinds
 * unowned-tab and duplicate-agent only, and only for a workspace token (ADR-0021: the global token mutates no
 * workspace): a duplicate agent of the caller's own workspace, or one the selected Scrum Master manages; an
 * unowned-tab process belongs to no workspace. Every other entry the caller may not reap is refused `forbidden`.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const body = req.method === 'POST' && req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const host = hostOf(req.method === 'POST' ? body.host : req.query.host);
  if (host === null) return res.status(400).json({ error: 'host must be a string', code: 'invalid-request' });

  let mayReap: TMayReap | undefined;
  if (req.method === 'POST') {
    if (body.reap !== true) return res.status(400).json({ error: 'POST reaps: send { "reap": true }', code: 'invalid-request' });
    const scope = resolveCliScope(req, { response: res });
    if (!scope || scope.type !== 'workspace') {
      return res.status(403).json({ error: 'a reap runs from a workspace token; the global token mutates no workspace', code: 'forbidden' });
    }
    mayReap = async (entry) => {
      if (entry.kind === 'unowned-tab') return true;
      if (entry.kind !== 'duplicate-agent' || !entry.workspaceId) return false;
      return isOwnWorkspace(scope, entry.workspaceId) || selectedScrumMasterMayMutate(scope, entry.workspaceId, req.url);
    };
  }

  try {
    return res.status(200).json(await sweepOrphans({ host, mayReap }));
  } catch (err) {
    if (err instanceof OrphanSweepError) return res.status(err.code === 'conflict' ? 409 : 400).json({ error: err.message, code: err.code });
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'orphan sweep failed');
    return res.status(500).json({ error: err instanceof Error ? err.message : 'orphan sweep failed' });
  }
};

export default handler;
