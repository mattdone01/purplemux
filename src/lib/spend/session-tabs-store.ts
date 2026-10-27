import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spendFloor, utcDay } from '@/lib/spend/spend-model';
import type { TSpendProvider } from '@/types/spend';

const STORE_FILE = path.join(os.homedir(), '.purplemux', 'session-tabs.json');
// A hook reports the same session many times a turn; a binding that is already
// known and fresh needs no write.
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface ISessionTabBinding {
  workspaceId: string;
  tabId: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface ISessionTabsData {
  version: 1;
  bindings: Record<string, ISessionTabBinding>;
}

export interface ISessionTabSighting {
  providerId: TSpendProvider;
  sessionId: string;
  workspaceId: string;
  tabId: string;
  seenAt: number;
}

export class SessionTabsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTabsStoreError';
  }
}

const g = globalThis as unknown as {
  __ptSessionTabsLock?: Promise<void>;
  __ptSessionTabsSeen?: Map<string, ISessionTabBinding>;
};
if (!g.__ptSessionTabsLock) g.__ptSessionTabsLock = Promise.resolve();
if (!g.__ptSessionTabsSeen) g.__ptSessionTabsSeen = new Map();
const seen = g.__ptSessionTabsSeen;

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const prev = g.__ptSessionTabsLock!;
  g.__ptSessionTabsLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

export const bindingKey = (providerId: TSpendProvider, sessionId: string): string => `${providerId}:${sessionId}`;

const isBinding = (value: unknown): value is ISessionTabBinding => {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return typeof b.workspaceId === 'string' && typeof b.tabId === 'string'
    && Number.isFinite(b.firstSeenAt) && Number.isFinite(b.lastSeenAt);
};

const readData = async (): Promise<ISessionTabsData> => {
  let raw: string;
  try {
    raw = await fs.readFile(STORE_FILE, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, bindings: {} };
    throw new SessionTabsStoreError(`session-tabs.json unreadable: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionTabsStoreError('session-tabs.json unreadable: the file is not JSON');
  }
  const data = parsed as Partial<ISessionTabsData> | null;
  if (!data || data.version !== 1 || !data.bindings || typeof data.bindings !== 'object' || Array.isArray(data.bindings)) {
    throw new SessionTabsStoreError('session-tabs.json unreadable: expected {version: 1, bindings: {...}}');
  }
  const bad = Object.entries(data.bindings).find(([, binding]) => !isBinding(binding));
  if (bad) throw new SessionTabsStoreError(`session-tabs.json unreadable: binding ${bad[0]} is malformed`);
  return { version: 1, bindings: data.bindings };
};

const writeData = async (data: ISessionTabsData): Promise<void> => {
  await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(tmp, STORE_FILE);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
};

/** A binding last seen before the spend floor attributes nothing spend still serves (ADR-0030 §3). */
const beforeFloor = (seenAt: number, now: number): boolean => utcDay(seenAt) < spendFloor(now);

const prune = (data: ISessionTabsData, now: number): boolean => {
  let pruned = false;
  for (const [key, binding] of Object.entries(data.bindings)) {
    if (beforeFloor(binding.lastSeenAt, now)) {
      delete data.bindings[key];
      pruned = true;
    }
  }
  return pruned;
};

const apply = (data: ISessionTabsData, sighting: ISessionTabSighting): boolean => {
  const key = bindingKey(sighting.providerId, sighting.sessionId);
  const current = Object.hasOwn(data.bindings, key) ? data.bindings[key] : undefined;
  if (current && current.workspaceId === sighting.workspaceId && current.tabId === sighting.tabId) {
    if (sighting.seenAt <= current.lastSeenAt) return false;
    current.lastSeenAt = sighting.seenAt;
    return true;
  }
  // A session moves to another tab only on a newer sighting (a resume in another tab).
  if (current && sighting.seenAt < current.lastSeenAt) return false;
  data.bindings[key] = {
    workspaceId: sighting.workspaceId,
    tabId: sighting.tabId,
    firstSeenAt: sighting.seenAt,
    lastSeenAt: sighting.seenAt,
  };
  return true;
};

/** Every binding, keyed `<provider>:<sessionId>`. A malformed file throws; it is never read as empty. */
export const readSessionTabs = async (): Promise<Record<string, ISessionTabBinding>> => (await readData()).bindings;

/** Record that a tab runs an agent session. Callers on the hook path must catch: a failure never fails them. */
export const recordSessionTab = async (sighting: Omit<ISessionTabSighting, 'seenAt'>, now = Date.now()): Promise<void> => {
  const key = bindingKey(sighting.providerId, sighting.sessionId);
  const known = seen.get(key);
  if (known && known.workspaceId === sighting.workspaceId && known.tabId === sighting.tabId
    && now - known.lastSeenAt < TOUCH_INTERVAL_MS) return;
  await withLock(async () => {
    const data = await readData();
    const changed = apply(data, { ...sighting, seenAt: now });
    if (prune(data, now) || changed) await writeData(data);
    const stored = data.bindings[key];
    if (stored) seen.set(key, { ...stored });
  });
};

/** Add what session history and the layouts already know; a newer stored sighting wins. */
export const seedSessionTabs = async (sightings: ISessionTabSighting[], now = Date.now()): Promise<number> =>
  withLock(async () => {
    const data = await readData();
    let changed = 0;
    for (const sighting of sightings) {
      if (beforeFloor(sighting.seenAt, now)) continue;
      if (apply(data, sighting)) changed += 1;
    }
    if (prune(data, now) || changed > 0) await writeData(data);
    return changed;
  });
