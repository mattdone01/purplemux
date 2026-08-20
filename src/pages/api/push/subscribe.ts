import type { NextApiRequest, NextApiResponse } from 'next';
import {
  addFcmSubscription,
  addSubscription,
  listDeviceEndpoints,
  listFcmDevices,
  removeFcmSubscription,
  removeFcmSubscriptionsByDevice,
  removeSubscription,
} from '@/lib/push-subscriptions';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'GET') {
    return res.status(200).json({ devices: await listDeviceEndpoints(), fcmDevices: await listFcmDevices() });
  }

  if (req.method === 'POST') {
    const body = req.body ?? {};
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : undefined;
    const label = typeof body.label === 'string' ? body.label : undefined;

    if (body.kind === 'fcm') {
      if (typeof body.token !== 'string' || !body.token) {
        return res.status(400).json({ error: 'Invalid FCM registration' });
      }
      await addFcmSubscription(body.token, { deviceId, label });
      return res.status(200).json({ ok: true });
    }

    // Bare PushSubscription bodies are what clients posted before the record
    // wrapper carried a deviceId; both shapes stay accepted.
    const sub = body.endpoint ? body : body.subscription;
    if (!sub?.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    await addSubscription(sub, { deviceId, label });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { endpoint, token, deviceId } = req.body ?? {};
    if (endpoint) {
      await removeSubscription(endpoint);
      return res.status(200).json({ ok: true });
    }
    if (token) {
      await removeFcmSubscription(token);
      return res.status(200).json({ ok: true });
    }
    // A deviceId reaches only the FCM rows: a browser drops its Web Push
    // subscription by endpoint, which is the identifier it holds.
    if (deviceId) {
      await removeFcmSubscriptionsByDevice(deviceId);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Missing endpoint, token or deviceId' });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
