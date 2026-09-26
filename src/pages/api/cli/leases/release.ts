import type { NextApiRequest, NextApiResponse } from 'next';
import { releaseLease } from '@/lib/lease-store';
import { bodyOf, holderOf, leaseAuthority, requireCaller, requireMethod, sendLeaseError } from '@/lib/lease-http';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    await releaseLease(bodyOf(req).name, holderOf(caller), leaseAuthority);
    return res.status(200).json({ released: true });
  } catch (err) {
    return sendLeaseError(res, err);
  }
};

export default handler;
