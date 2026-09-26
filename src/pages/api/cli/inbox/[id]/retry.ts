import type { NextApiRequest, NextApiResponse } from 'next';
import { InboxError, mutateInbox, readInboxState, retryInState } from '@/lib/inbox-store';
import { resolveCliScope } from '@/lib/workspace-token';

/**
 * Re-queue a `held` notice once, with a fresh refusal budget. Only the target
 * workspace's own token or the admin token may: a retry types into that
 * workspace's tab.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const scope = resolveCliScope(req);
  if (!scope) return res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
  const id = req.query.id as string;

  const item = (await readInboxState()).items.find((i) => i.id === id);
  if (!item) return res.status(404).json({ error: `inbox item ${id} not found`, code: 'inbox-not-found' });
  if (scope.type !== 'admin' && scope.workspaceId !== item.targetWorkspaceId) {
    return res.status(403).json({ error: `inbox item ${id} targets ${item.targetWorkspaceId}; only that workspace's token or the admin token may retry it`, code: 'forbidden' });
  }
  try {
    const retried = await mutateInbox((state) => {
      const result = retryInState(state, id, Date.now());
      return { state: result.state, value: result.item };
    });
    return res.status(200).json({ item: retried });
  } catch (err) {
    if (err instanceof InboxError) {
      return res.status(err.code === 'inbox-not-found' ? 404 : 409).json({ error: err.message, code: err.code });
    }
    throw err;
  }
};

export default handler;
