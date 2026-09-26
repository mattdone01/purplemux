import type { NextApiRequest, NextApiResponse } from 'next';
import { releaseEpicClaims } from '@/lib/lease-store';
import { bodyOf, holderOf, leaseAuthority, requireCaller, requireMethod, sendLeaseError } from '@/lib/lease-http';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const body = bodyOf(req);
    const released = await releaseEpicClaims(body.epic, holderOf(caller), leaseAuthority, body.kind);
    return res.status(200).json({ released: released.map((l) => l.name) });
  } catch (err) {
    return sendLeaseError(res, err);
  }
};

export default handler;
