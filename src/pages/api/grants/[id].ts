import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, defaultGrantDeps, requireGrantHuman, sendGrantError } from '@/lib/grant-http';
import { revokeGrant } from '@/lib/grant-service';

/** Revoke a grant (ADR-0014): the same human gate and step-up password as creating one. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const subject = await requireGrantHuman(req);
    const grant = await revokeGrant(defaultGrantDeps(), subject, req.query.id, bodyOf(req).password);
    return res.status(200).json({ grant });
  } catch (err) {
    return sendGrantError(res, err);
  }
};

export default handler;
