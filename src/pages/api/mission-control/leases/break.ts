import type { NextApiRequest, NextApiResponse } from 'next';
import { LeasePolicyError } from '@/lib/lease-policy';
import { breakLease } from '@/lib/lease-store';
import { bodyOf, leaseAuthority, sendLeaseError, viewOf } from '@/lib/lease-http';
import { requireMissionHumanMutation, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';

/** The human session breaks a lease as the admin `lease break` does, recorded as `{human: <subject>}` (ADR-0029 §8). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  let actor: string;
  try {
    ({ actor } = await requireMissionHumanMutation(req));
  } catch (error) {
    return sendMissionError(res, error);
  }
  try {
    const body = bodyOf(req);
    const broken = await breakLease(body.name, body.reason, { human: actor }, leaseAuthority);
    return res.status(200).json({ broken: await viewOf(broken) });
  } catch (err) {
    if (err instanceof LeasePolicyError) return res.status(400).json({ error: err.message, code: 'invalid-request' });
    return sendLeaseError(res, err);
  }
};

export default handler;
