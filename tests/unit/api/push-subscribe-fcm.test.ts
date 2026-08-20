import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
  const state: IFakeResponse = { statusCode: 0, body: undefined, res: undefined as unknown as NextApiResponse };
  state.res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
    end() { return this; },
  } as unknown as NextApiResponse;
  return state;
};

let handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

const call = async (method: string, body?: unknown) => {
  const res = fakeResponse();
  await handler({ method, body } as NextApiRequest, res.res);
  return res;
};

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

beforeEach(async () => {
  mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-fcm-api-'));
  vi.resetModules();
  ({ default: handler } = await import('@/pages/api/push/subscribe'));
});

describe('POST /api/push/subscribe with kind: fcm', () => {
  it('stores an FCM registration and lists it without the token', async () => {
    const posted = await call('POST', { kind: 'fcm', token: 'tok-a', deviceId: 'D2', label: 'Pixel' });
    expect(posted.statusCode).toBe(200);
    expect(posted.body).toEqual({ ok: true });

    const listed = await call('GET');
    expect(listed.body).toEqual({
      devices: [],
      fcmDevices: [{ deviceId: 'D2', label: 'Pixel', createdAt: expect.any(Number) }],
    });
    expect(JSON.stringify(listed.body)).not.toContain('tok-a');
  });

  it('upserts a duplicate token', async () => {
    await call('POST', { kind: 'fcm', token: 'tok-a', deviceId: 'D2', label: 'Pixel' });
    await call('POST', { kind: 'fcm', token: 'tok-a', deviceId: 'D2', label: 'Pixel 9' });

    const listed = await call('GET');
    expect((listed.body as { fcmDevices: unknown[] }).fcmDevices).toEqual([
      { deviceId: 'D2', label: 'Pixel 9', createdAt: expect.any(Number) },
    ]);
  });

  it('rejects an FCM body with no token', async () => {
    const res = await call('POST', { kind: 'fcm', deviceId: 'D2' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid FCM registration' });
  });
});

describe('DELETE /api/push/subscribe', () => {
  it('removes an FCM registration by token', async () => {
    await call('POST', { kind: 'fcm', token: 'tok-a', deviceId: 'D2' });

    const res = await call('DELETE', { token: 'tok-a' });

    expect(res.statusCode).toBe(200);
    expect((await call('GET')).body).toEqual({ devices: [], fcmDevices: [] });
  });

  it('removes every FCM registration for one device', async () => {
    await call('POST', { kind: 'fcm', token: 'tok-old', deviceId: 'D2' });
    await call('POST', { kind: 'fcm', token: 'tok-new', deviceId: 'D2' });
    await call('POST', { kind: 'fcm', token: 'tok-other', deviceId: 'D3' });

    await call('DELETE', { deviceId: 'D2' });

    expect((await call('GET')).body).toEqual({
      devices: [],
      fcmDevices: [{ deviceId: 'D3', label: undefined, createdAt: expect.any(Number) }],
    });
  });

  it('still removes a Web Push subscription by endpoint, leaving FCM rows alone', async () => {
    await call('POST', { ...sub('https://push/1'), deviceId: 'D1' });
    await call('POST', { kind: 'fcm', token: 'tok-a', deviceId: 'D2' });

    await call('DELETE', { endpoint: 'https://push/1' });

    const listed = (await call('GET')).body as { devices: unknown[]; fcmDevices: unknown[] };
    expect(listed.devices).toEqual([]);
    expect(listed.fcmDevices).toHaveLength(1);
  });

  it('rejects a body that names nothing to remove', async () => {
    const res = await call('DELETE', {});

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Missing endpoint, token or deviceId' });
  });
});

describe('the Web Push path is unchanged', () => {
  it('accepts a bare PushSubscription body and a wrapped one', async () => {
    expect((await call('POST', { ...sub('https://push/bare'), deviceId: 'D1' })).statusCode).toBe(200);
    expect((await call('POST', { subscription: sub('https://push/wrapped'), deviceId: 'D2', label: 'Desk' })).statusCode).toBe(200);

    const listed = (await call('GET')).body as { devices: { endpoint: string }[] };
    expect(listed.devices.map((d) => d.endpoint)).toEqual(['https://push/bare', 'https://push/wrapped']);
  });

  it('rejects a body that is neither a subscription nor an FCM registration', async () => {
    const res = await call('POST', { deviceId: 'D1' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid subscription' });
  });
});
