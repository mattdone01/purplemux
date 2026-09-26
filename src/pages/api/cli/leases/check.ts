import type { NextApiRequest, NextApiResponse } from 'next';
import { findLease, sameHolder } from '@/lib/lease-store';
import { holderOf, requireCaller, requireMethod, sendLeaseError, viewOf } from '@/lib/lease-http';

/**
 * Exact name only — a prefix list would also answer for `merge:x/y-z`. This
 * body is the contract bash-guard, the command bodies and the number allocator
 * branch on: `{ held, mine, lease }`, always 200 when the store answers.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'GET')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const lease = await findLease(req.query.name);
    const mine = !!lease && sameHolder(lease.holder, holderOf(caller));
    return res.status(200).json({ held: !!lease, mine, lease: lease ? await viewOf(lease) : null });
  } catch (err) {
    return sendLeaseError(res, err);
  }
};

export default handler;
