import type { NextApiRequest, NextApiResponse } from 'next';
import { canAccessWorkspace } from '@/lib/cli-utils';
import { inboxItemView } from '@/lib/inbox-messages';
import { readInboxState } from '@/lib/inbox-store';
import { resolveCliScope } from '@/lib/workspace-token';

/**
 * One inbox item and its delivery state (ADR-0050): how the sender of a queued `tab send` reads `queued`, `delivered`,
 * `held`, `refused` or `expired`. Read scope of the target workspace, like `inbox list`; an item outside it answers
 * exactly like a missing one. A message's body is never served.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const scope = resolveCliScope(req, { response: res });
  if (!scope) return res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
  const id = req.query.id as string;
  const item = (await readInboxState()).items.find((i) => i.id === id);
  if (!item || !(await canAccessWorkspace(scope, item.targetWorkspaceId))) {
    return res.status(404).json({ error: `inbox item ${id} not found for this token`, code: 'inbox-not-found' });
  }
  return res.status(200).json({ item: inboxItemView(item) });
};

export default handler;
