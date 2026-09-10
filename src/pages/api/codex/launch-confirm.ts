import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspaceInput } from '@/lib/cli-utils';
import {
  confirmCodexLaunchReceiptLocked,
  withCodexTargetLock,
} from '@/lib/providers/codex/launch-lifecycle';
import { getStatusManager } from '@/lib/status-manager';

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const positivePid = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 1 ? value : null;

const isLoopbackAddress = (address: string | undefined): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const workspaceId = nonEmptyString(req.body?.workspaceId);
  const tabId = nonEmptyString(req.body?.tabId);
  const generation = nonEmptyString(req.body?.generation);
  const launcherPid = positivePid(req.body?.launcherPid);
  const childPid = positivePid(req.body?.childPid);
  if (!workspaceId || !tabId || !generation || !launcherPid || !childPid) {
    return res.status(400).json({ error: 'Invalid Codex launch receipt' });
  }
  if (!(await authorizeWorkspaceInput(req, res, workspaceId))) return;

  const result = await withCodexTargetLock(workspaceId, tabId, async () => {
    const confirmed = await confirmCodexLaunchReceiptLocked({
      workspaceId,
      tabId,
      generation,
      launcherPid,
      childPid,
    });
    if (confirmed.ok) {
      getStatusManager().applyConfirmedCodexLaunch(
        tabId,
        confirmed.active.generation,
        confirmed.active.resumeSessionId,
      );
    }
    return confirmed;
  });
  if (!result.ok) {
    return res.status(result.state === 'not-found' ? 404 : 409).json({
      error: 'Codex launch confirmation rejected',
      state: result.state,
      reason: result.reason,
    });
  }
  return res.status(200).json({ generation, state: result.state });
};

export default handler;
