import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { PushSubscription } from 'web-push';
const BASE_DIR = path.join(os.homedir(), '.purplemux');
const SUBS_FILE = path.join(BASE_DIR, 'push-subscriptions.json');

/**
 * A subscription plus the device that owns it. The `deviceId` binding is what
 * makes the push visibility gate per-device: a focused desktop must not mute
 * the phone. Rows written before this wrapper existed are bare
 * `PushSubscription` objects and migrate on read.
 */
export interface IPushSubscriptionRecord {
  subscription: PushSubscription;
  deviceId?: string;
  label?: string;
  createdAt: number;
}

export interface IPushSubscriptionMeta {
  deviceId?: string;
  label?: string;
}

const g = globalThis as unknown as { __ptPushLock?: Promise<void> };
if (!g.__ptPushLock) g.__ptPushLock = Promise.resolve();

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g.__ptPushLock!;
  g.__ptPushLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

export const normalizeSubscriptionRecords = (raw: unknown): IPushSubscriptionRecord[] => {
  if (!Array.isArray(raw)) return [];
  const records: IPushSubscriptionRecord[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const fields = row as Record<string, unknown>;
    const isBare = typeof fields.endpoint === 'string';
    const subscription = (isBare ? fields : fields.subscription) as PushSubscription | undefined;
    if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.endpoint) continue;

    const record: IPushSubscriptionRecord = {
      subscription,
      createdAt: typeof fields.createdAt === 'number' ? fields.createdAt : 0,
    };
    if (typeof fields.deviceId === 'string' && fields.deviceId) record.deviceId = fields.deviceId;
    if (typeof fields.label === 'string' && fields.label) record.label = fields.label;
    records.push(record);
  }
  return records;
};

const readSubs = async (): Promise<IPushSubscriptionRecord[]> => {
  try {
    const raw = await fs.readFile(SUBS_FILE, 'utf-8');
    return normalizeSubscriptionRecords(JSON.parse(raw));
  } catch {
    return [];
  }
};

const writeSubs = async (subs: IPushSubscriptionRecord[]): Promise<void> => {
  await fs.mkdir(BASE_DIR, { recursive: true });
  const tmp = SUBS_FILE + '.tmp';
  try {
    await fs.writeFile(tmp, JSON.stringify(subs, null, 2), { mode: 0o600 });
    await fs.rename(tmp, SUBS_FILE);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
};

export const getSubscriptionRecords = async (): Promise<IPushSubscriptionRecord[]> => readSubs();

export const listDeviceEndpoints = async (): Promise<{ endpoint: string; deviceId?: string; label?: string; createdAt: number }[]> =>
  (await readSubs()).map((r) => ({
    endpoint: r.subscription.endpoint,
    deviceId: r.deviceId,
    label: r.label,
    createdAt: r.createdAt,
  }));

export const addSubscription = async (sub: PushSubscription, meta: IPushSubscriptionMeta = {}): Promise<void> =>
  withLock(async () => {
    const subs = await readSubs();
    const idx = subs.findIndex((s) => s.subscription.endpoint === sub.endpoint);
    const existing = idx >= 0 ? subs[idx] : null;
    const record: IPushSubscriptionRecord = {
      subscription: sub,
      createdAt: existing?.createdAt || Date.now(),
    };
    const deviceId = meta.deviceId ?? existing?.deviceId;
    const label = meta.label ?? existing?.label;
    if (deviceId) record.deviceId = deviceId;
    if (label) record.label = label;

    if (idx >= 0) {
      subs[idx] = record;
    } else {
      subs.push(record);
    }
    await writeSubs(subs);
  });

export const removeSubscription = async (endpoint: string): Promise<void> =>
  withLock(async () => {
    const subs = await readSubs();
    const filtered = subs.filter((s) => s.subscription.endpoint !== endpoint);
    if (filtered.length !== subs.length) {
      await writeSubs(filtered);
    }
  });

const VISIBILITY_TTL = 60_000;
const gVis = globalThis as unknown as { __ptVisibleDevices?: Map<string, number> };
if (!gVis.__ptVisibleDevices) gVis.__ptVisibleDevices = new Map();
const visibleDevices = gVis.__ptVisibleDevices;

export const markDeviceVisible = (deviceId: string): void => {
  visibleDevices.set(deviceId, Date.now());
};

export const markDeviceHidden = (deviceId: string): void => {
  visibleDevices.delete(deviceId);
};

export const isDeviceVisible = (deviceId: string): boolean => {
  const lastSeen = visibleDevices.get(deviceId);
  if (lastSeen === undefined) return false;
  if (Date.now() - lastSeen > VISIBILITY_TTL) {
    visibleDevices.delete(deviceId);
    return false;
  }
  return true;
};

// Fallback gate for subscriptions with no device binding — rows that predate the
// record migration and have not re-subscribed yet. Keeps their pre-existing
// "any focused window mutes push" behaviour instead of pushing to them blind.
export const isAnyDeviceVisible = (): boolean => {
  const now = Date.now();
  for (const [deviceId, lastSeen] of visibleDevices) {
    if (now - lastSeen > VISIBILITY_TTL) {
      visibleDevices.delete(deviceId);
    } else {
      return true;
    }
  }
  return false;
};

const gActive = globalThis as unknown as { __ptSessionPushTarget?: Map<string, string> };
if (!gActive.__ptSessionPushTarget) gActive.__ptSessionPushTarget = new Map();
const sessionPushTarget = gActive.__ptSessionPushTarget;

export const setSessionPushTarget = (sessionId: string, endpoint: string): void => {
  sessionPushTarget.set(sessionId, endpoint);
};

export const clearSessionPushTarget = (sessionId: string): void => {
  sessionPushTarget.delete(sessionId);
};

export const getSessionPushEndpoint = (sessionId: string): string | null =>
  sessionPushTarget.get(sessionId) ?? null;
