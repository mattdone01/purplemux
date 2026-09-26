import type { NextApiRequest, NextApiResponse } from 'next';
import { renewLease } from '@/lib/lease-store';
import { bodyOf, holderOf, leaseAuthority, requireCaller, requireMethod, sendLeaseError, ttlOf, viewOf } from '@/lib/lease-http';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const body = bodyOf(req);
    const lease = await renewLease(body.name, ttlOf(body), holderOf(caller), leaseAuthority);
    return res.status(200).json({ lease: await viewOf(lease) });
  } catch (err) {
    return sendLeaseError(res, err);
  }
};

export default handler;
