import type { NextApiRequest, NextApiResponse } from 'next';
import { listLeases, sameHolder } from '@/lib/lease-store';
import { holderOf, requireCaller, requireMethod, sendLeaseError, viewsOf } from '@/lib/lease-http';

/** Host-wide register: any valid CLI scope reads it (ADR-0011). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'GET')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : undefined;
    let leases = await listLeases(prefix);
    if (req.query.mine === '1') {
      const me = holderOf(caller);
      leases = leases.filter((l) => sameHolder(l.holder, me));
    }
    return res.status(200).json({ leases: await viewsOf(leases) });
  } catch (err) {
    return sendLeaseError(res, err);
  }
};

export default handler;
