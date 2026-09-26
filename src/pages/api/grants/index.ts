import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, defaultGrantDeps, requireGrantHuman, sendGrantError } from '@/lib/grant-http';
import { createGrant } from '@/lib/grant-service';
import { grantsSnapshot } from '@/lib/grant-store';

/**
 * Portfolio drive grants (ADR-0014). GET lists them for the signed-in human;
 * POST creates one — a web session, this server's Origin AND the purplemux
 * password. No CLI token, admin or workspace, reaches this route.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    if (req.method === 'GET') {
      await requireGrantHuman(req);
      return res.status(200).json({ grants: grantsSnapshot().grants });
    }
    if (req.method === 'POST') {
      const subject = await requireGrantHuman(req);
      const grant = await createGrant(defaultGrantDeps(), subject, bodyOf(req));
      return res.status(201).json({ grant });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return sendGrantError(res, err);
  }
};

export default handler;
