import type { NextApiRequest, NextApiResponse } from 'next';
import { defaultGrantDeps, requireGrantHuman, sendGrantError } from '@/lib/grant-http';
import { revokeGrant } from '@/lib/grant-service';

/** Revoke a grant (ADR-0014): the human session and this server's Origin; no password (it only takes power away). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const subject = await requireGrantHuman(req);
    const grant = await revokeGrant(defaultGrantDeps(), subject, req.query.id);
    return res.status(200).json({ grant });
  } catch (err) {
    return sendGrantError(res, err);
  }
};

export default handler;
