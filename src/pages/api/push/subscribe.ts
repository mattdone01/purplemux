import type { NextApiRequest, NextApiResponse } from 'next';
import { addSubscription, removeSubscription, listDeviceEndpoints } from '@/lib/push-subscriptions';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'GET') {
    return res.status(200).json({ devices: await listDeviceEndpoints() });
  }

  if (req.method === 'POST') {
    const body = req.body ?? {};
    // Bare PushSubscription bodies are what clients posted before the record
    // wrapper carried a deviceId; both shapes stay accepted.
    const sub = body.endpoint ? body : body.subscription;
    if (!sub?.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : undefined;
    const label = typeof body.label === 'string' ? body.label : undefined;
    await addSubscription(sub, { deviceId, label });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { endpoint } = req.body ?? {};
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }
    await removeSubscription(endpoint);
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
