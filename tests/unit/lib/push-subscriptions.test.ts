import { beforeEach, describe, expect, it } from 'vitest';
import {
  isAnyDeviceVisible,
  isDeviceVisible,
  markDeviceHidden,
  markDeviceVisible,
  normalizeSubscriptionRecords,
} from '@/lib/push-subscriptions';

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

describe('normalizeSubscriptionRecords', () => {
  it('wraps bare PushSubscription rows written before the record migration', () => {
    expect(normalizeSubscriptionRecords([sub('https://push/1')])).toEqual([
      { subscription: sub('https://push/1'), createdAt: 0 },
    ]);
  });

  it('keeps already-wrapped records with their device binding', () => {
    const raw = [{ subscription: sub('https://push/2'), deviceId: 'D2', label: 'Pixel', createdAt: 42 }];
    expect(normalizeSubscriptionRecords(raw)).toEqual(raw);
  });

  it('mixes legacy and migrated rows in one file', () => {
    const records = normalizeSubscriptionRecords([
      sub('https://push/1'),
      { subscription: sub('https://push/2'), deviceId: 'D2', createdAt: 42 },
    ]);
    expect(records.map((r) => r.subscription.endpoint)).toEqual(['https://push/1', 'https://push/2']);
    expect(records[0].deviceId).toBeUndefined();
    expect(records[1].deviceId).toBe('D2');
  });

  it('drops rows with no usable endpoint', () => {
    expect(normalizeSubscriptionRecords([null, 'x', {}, { subscription: {} }, { endpoint: '' }])).toEqual([]);
  });

  it('returns an empty list for a non-array file body', () => {
    expect(normalizeSubscriptionRecords({ endpoint: 'https://push/1' })).toEqual([]);
  });
});

describe('device visibility', () => {
  beforeEach(() => {
    markDeviceHidden('D1');
    markDeviceHidden('D2');
  });

  it('tracks visibility per device', () => {
    markDeviceVisible('D1');
    expect(isDeviceVisible('D1')).toBe(true);
    expect(isDeviceVisible('D2')).toBe(false);
    expect(isAnyDeviceVisible()).toBe(true);
  });

  it('forgets a device once it reports hidden', () => {
    markDeviceVisible('D1');
    markDeviceHidden('D1');
    expect(isDeviceVisible('D1')).toBe(false);
    expect(isAnyDeviceVisible()).toBe(false);
  });

  it('treats an unknown device as not visible', () => {
    expect(isDeviceVisible('never-seen')).toBe(false);
  });
});
