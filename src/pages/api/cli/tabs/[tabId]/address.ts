import type { NextApiRequest, NextApiResponse } from 'next';
import { defaultAddressLookupDeps, lookupAddress } from '@/lib/address-lookup';
import { resolveCaller } from '@/lib/caller';
import { remoteHostUnreachableBody } from '@/lib/cli-error';
import { RemoteHostError } from '@/lib/remote-host';

/**
 * A Claude seat's SendMessage address (ADR-0050, S1): `{ tabId, workspaceId, address: "uds:…", permissionMode,
 * registeredAt, lastSeenAt }`. Every refusal names the fallback, `purplemux tab send`, which queues; between
 * workspaces it names `purplemux note send`. Each lookup writes one `address-lookup` audit line.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const tabId = req.query.tabId as string;
  // A missing workspaceId is refused by the lookup itself, so the refusal is audited too (review N2).
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
  try {
    const answer = await lookupAddress(await defaultAddressLookupDeps(), await resolveCaller(req, res), { workspaceId, tabId });
    return res.status(answer.status).json(answer.body);
  } catch (err) {
    if (err instanceof RemoteHostError && !res.headersSent) return res.status(503).json(remoteHostUnreachableBody(err));
    throw err;
  }
};

export default handler;
