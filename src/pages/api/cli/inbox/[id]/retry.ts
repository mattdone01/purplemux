import type { NextApiRequest, NextApiResponse } from 'next';
import { InboxError, mutateInbox, readInboxState, retryInState } from '@/lib/inbox-store';
import { noticeSenderWorkspace, readNotesState } from '@/lib/notes-store';
import { resolveCliScope } from '@/lib/workspace-token';
import type { IInboxItem } from '@/types/inbox';

/**
 * Re-queue a `held` notice once, with a fresh refusal budget. The target
 * workspace's own token, the admin token, or the workspace that sent the note a
 * notice carries may: the sender already holds the authority that routed it, and
 * the note's paste-time preflight still decides whether it is typed.
 */
const mayRetry = async (scope: NonNullable<ReturnType<typeof resolveCliScope>>, item: IInboxItem): Promise<boolean> => {
  if (scope.type === 'admin' || scope.workspaceId === item.targetWorkspaceId) return true;
  return item.kind === 'note' && noticeSenderWorkspace(await readNotesState(), item.id) === scope.workspaceId;
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const scope = resolveCliScope(req, { response: res });
  if (!scope) return res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
  const id = req.query.id as string;

  const item = (await readInboxState()).items.find((i) => i.id === id);
  // Another workspace's item answers exactly like a missing one: its id leaks nothing.
  if (!item || !(await mayRetry(scope, item))) {
    return res.status(404).json({ error: `inbox item ${id} not found for this token (only the target workspace's token, the note's sending workspace or the admin token may retry)`, code: 'inbox-not-found' });
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
