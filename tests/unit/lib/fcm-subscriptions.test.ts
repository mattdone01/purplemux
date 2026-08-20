import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeSubscriptionRecords } from '@/lib/push-subscriptions';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

const importStore = async () => {
  vi.resetModules();
  return import('@/lib/push-subscriptions');
};

const readFile = async () =>
  JSON.parse(await fs.readFile(path.join(mockHome.value, '.purplemux', 'push-subscriptions.json'), 'utf-8'));

beforeEach(async () => {
  mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-fcm-subs-'));
});

describe('normalizeSubscriptionRecords with FCM rows', () => {
  it('keeps an FCM row beside a Web Push row in one file', () => {
    const records = normalizeSubscriptionRecords([
      { subscription: sub('https://push/1'), deviceId: 'D1', createdAt: 1 },
      { kind: 'fcm', token: 'tok-a', deviceId: 'D2', label: 'Pixel', createdAt: 2 },
    ]);

    expect(records).toEqual([
      { subscription: sub('https://push/1'), deviceId: 'D1', createdAt: 1 },
      { kind: 'fcm', token: 'tok-a', deviceId: 'D2', label: 'Pixel', createdAt: 2 },
    ]);
  });

  it('drops an FCM row with no usable token', () => {
    expect(normalizeSubscriptionRecords([
      { kind: 'fcm', createdAt: 0 },
      { kind: 'fcm', token: '', createdAt: 0 },
      { kind: 'fcm', token: 42, createdAt: 0 },
    ])).toEqual([]);
  });

  it('leaves a legacy bare Web Push row untouched', () => {
    expect(normalizeSubscriptionRecords([sub('https://push/1')])).toEqual([
      { subscription: sub('https://push/1'), createdAt: 0 },
    ]);
  });
});

describe('FCM subscription storage', () => {
  it('round-trips a subscription and hides the token from the device listing', async () => {
    const store = await importStore();

    await store.addFcmSubscription('tok-a', { deviceId: 'D2', label: 'Pixel' });

    expect(await store.getFcmSubscriptionRecords()).toEqual([
      { kind: 'fcm', token: 'tok-a', deviceId: 'D2', label: 'Pixel', createdAt: expect.any(Number) },
    ]);
    const listed = await store.listFcmDevices();
    expect(listed).toEqual([{ deviceId: 'D2', label: 'Pixel', createdAt: expect.any(Number) }]);
    expect(JSON.stringify(listed)).not.toContain('tok-a');

    await store.removeFcmSubscription('tok-a');
    expect(await store.getFcmSubscriptionRecords()).toEqual([]);
  });

  it('upserts a duplicate token instead of appending it, keeping the original createdAt', async () => {
    const store = await importStore();

    await store.addFcmSubscription('tok-a', { deviceId: 'D2', label: 'Pixel' });
    const first = (await store.getFcmSubscriptionRecords())[0];
    await store.addFcmSubscription('tok-a', { label: 'Pixel 9' });

    const records = await store.getFcmSubscriptionRecords();
    expect(records).toHaveLength(1);
    expect(records[0].createdAt).toBe(first.createdAt);
    expect(records[0].label).toBe('Pixel 9');
    expect(records[0].deviceId).toBe('D2');
  });

  it('removes every FCM row for one device', async () => {
    const store = await importStore();

    await store.addFcmSubscription('tok-old', { deviceId: 'D2' });
    await store.addFcmSubscription('tok-new', { deviceId: 'D2' });
    await store.addFcmSubscription('tok-other', { deviceId: 'D3' });

    expect(await store.removeFcmSubscriptionsByDevice('D2')).toBe(2);
    expect((await store.getFcmSubscriptionRecords()).map((r) => r.token)).toEqual(['tok-other']);
  });

  it('keeps the two kinds out of each other\'s way in the shared file', async () => {
    const store = await importStore();

    await store.addSubscription(sub('https://push/1'), { deviceId: 'D1' });
    await store.addFcmSubscription('tok-a', { deviceId: 'D2' });
    await store.addSubscription(sub('https://push/2'), { deviceId: 'D3' });

    expect((await store.getSubscriptionRecords()).map((r) => r.subscription.endpoint))
      .toEqual(['https://push/1', 'https://push/2']);
    expect((await store.getFcmSubscriptionRecords()).map((r) => r.token)).toEqual(['tok-a']);
    expect((await store.listDeviceEndpoints()).map((d) => d.endpoint))
      .toEqual(['https://push/1', 'https://push/2']);
    expect(await readFile()).toHaveLength(3);

    await store.removeSubscription('https://push/1');
    expect((await store.getFcmSubscriptionRecords()).map((r) => r.token)).toEqual(['tok-a']);

    await store.removeFcmSubscription('tok-a');
    expect((await store.getSubscriptionRecords()).map((r) => r.subscription.endpoint))
      .toEqual(['https://push/2']);
  });
});
