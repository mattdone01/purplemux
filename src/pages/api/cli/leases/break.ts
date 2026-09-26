import type { NextApiRequest, NextApiResponse } from 'next';
import { breakLease } from '@/lib/lease-store';
import { bodyOf, holderOf, leaseAuthority, requireCaller, requireMethod, sendLeaseError, viewOf } from '@/lib/lease-http';

/** Admin token only, with a reason; audited. Cooperative, not a security boundary (C-312 class). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const body = bodyOf(req);
    const broken = await breakLease(body.name, body.reason, holderOf(caller), leaseAuthority);
    return res.status(200).json({ broken: await viewOf(broken) });
  } catch (err) {
    return sendLeaseError(res, err);
  }
};

export default handler;
