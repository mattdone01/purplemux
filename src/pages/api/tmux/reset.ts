import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { listSessions, killServer, scanSessions, applyConfig } from '@/lib/tmux';
import { initWorkspaceStore } from '@/lib/workspace-store';
import { autoResumeOnStartup } from '@/lib/auto-resume';
import { getStatusManager } from '@/lib/status-manager';
import { createLogger } from '@/lib/logger';

const log = createLogger('terminal');

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sessions = await listSessions();
    log.info(`tmux reset requested — killing ${sessions.length} session(s)`);
    await killServer();

    await scanSessions();
    await applyConfig();
    await initWorkspaceStore();
    await autoResumeOnStartup();
    await getStatusManager().rescan();

    log.info('tmux re-initialized after reset');
    return res.status(200).json({ killed: sessions.length });
  } catch (err) {
    log.error(`tmux reset failed: ${err instanceof Error ? err.message : err}`);
    return res.status(500).json({ error: 'tmux reset failed' });
  }
};

export default handler;
