import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, defaultGrantDeps, listGrantees, requireGrantHuman, sendGrantError } from '@/lib/grant-http';
import { createGrant } from '@/lib/grant-service';
import { grantsRefusal, grantsSnapshot } from '@/lib/grant-store';
import { requireMissionHuman } from '@/lib/mission-control-http';

/**
 * Portfolio drive grants (ADR-0014). GET lists them for the signed-in human
 * with the grantee tabs; POST creates one — a web session, this server's Origin
 * AND the purplemux password. No CLI token, admin or workspace, reaches this route.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    if (req.method === 'GET') {
      // A read needs the session only, like the other human reads (story 28 review r1): a browser's
      // same-origin GET over plain HTTP to a LAN address carries neither Origin nor Sec-Fetch-Site.
      await requireMissionHuman(req);
      const refusal = grantsRefusal();
      if (refusal) return res.status(500).json({ error: refusal, code: 'grant-store-unreadable' });
      let grantees: Awaited<ReturnType<typeof listGrantees>> | null = null;
      let granteesError: string | null = null;
      try {
        grantees = await listGrantees();
      } catch (err) {
        granteesError = err instanceof Error ? err.message : String(err);
      }
      return res.status(200).json({
        grants: grantsSnapshot().grants,
        grantees: grantees?.grantees ?? [],
        unreadableWorkspaceIds: grantees?.unreadableWorkspaceIds ?? [],
        granteesError,
        // The server's clock: a viewer with a skewed clock still shows the grants the server enforces.
        serverNow: Date.now(),
      });
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
