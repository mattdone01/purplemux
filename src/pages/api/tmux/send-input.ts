import { withRecordedTerminalInput } from '@/lib/terminal-input';
import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { hasSession, sendRawKeys } from '@/lib/tmux';
import { createLogger } from '@/lib/logger';

const log = createLogger('tmux');

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { session, input } = req.body as { session?: string; input?: string };

  if (!session || !input) {
    return res.status(400).json({ error: 'session and input parameters required' });
  }

  const exists = await hasSession(session);
  if (!exists) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    await withRecordedTerminalInput(session, input, () => sendRawKeys(session, input));
    return res.status(200).json({ ok: true });
  } catch (err) {
    log.error(`send-input failed: ${err instanceof Error ? err.message : err}`);
    return res.status(500).json({ error: 'Failed to send input' });
  }
};

export default handler;
