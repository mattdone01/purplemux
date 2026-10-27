import type { NextApiRequest, NextApiResponse } from 'next';
import { InboxError, mutateInbox, retryHumanInState } from '@/lib/inbox-store';
import { requireMissionHumanMutation, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';

/**
 * The human session re-queues a held notice of any workspace once, as `inbox retry` does
 * (ADR-0029 §7). It types nothing; a hold that a retry could double, or that can never succeed,
 * is refused with its reason.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    await requireMissionHumanMutation(req);
  } catch (error) {
    return sendMissionError(res, error);
  }
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  try {
    const item = await mutateInbox((state) => {
      const result = retryHumanInState(state, String(id ?? ''), Date.now());
      return { state: result.state, value: result.item };
    });
    return res.status(200).json({ item });
  } catch (err) {
    if (err instanceof InboxError) {
      return res.status(err.code === 'inbox-not-found' ? 404 : 409)
        .json({ error: err.message, code: err.code, ...(err.reason ? { reason: err.reason } : {}) });
    }
    return sendMissionError(res, err);
  }
};

export default handler;
