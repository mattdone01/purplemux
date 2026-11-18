import type { NextApiRequest, NextApiResponse } from 'next';
import { canAccessWorkspace } from '@/lib/cli-utils';
import { redactGithubUsage } from '@/lib/github-usage';
import { getGithubUsageView } from '@/lib/github-usage-service';
import { requireCaller, requireMethod } from '@/lib/lease-http';
import { createLogger } from '@/lib/logger';

const log = createLogger('github-usage');

/**
 * `purplemux github usage`: any valid CLI scope may read it. The owners in a workspace the caller
 * cannot read show as `other`, with their counts kept; the admin token reads all.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!requireMethod(req, res, 'GET')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const view = await getGithubUsageView();
    return res.status(200).json(caller.admin ? view : await redactGithubUsage(view, (ws) => canAccessWorkspace(caller.scope, ws)));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`github usage view failed: ${detail}`);
    return res.status(503).json({ error: `the GitHub usage could not be read: ${detail}`, code: 'github-usage-unreadable' });
  }
};

export default handler;
