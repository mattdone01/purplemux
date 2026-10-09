import fs from 'fs/promises';
import path from 'path';
import { resolveLayoutDir } from '@/lib/layout-store';
import { parseBurndownSnapshot } from '@/lib/burndown';
import type { IBurndownRecord } from '@/types/burndown';

export class BurndownStoreError extends Error {}

const g = globalThis as unknown as {
  __ptBurndownLocks?: Map<string, Promise<void>>;
};
if (!g.__ptBurndownLocks) g.__ptBurndownLocks = new Map();

const withLock = async <T>(wsId: string, fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__ptBurndownLocks!.get(wsId) ?? Promise.resolve();
  g.__ptBurndownLocks!.set(wsId, next);
  await prev;
  try {
    return await fn();
  } finally {
    release!();
    if (g.__ptBurndownLocks!.get(wsId) === next) {
      g.__ptBurndownLocks!.delete(wsId);
    }
  }
};

const resolveBurndownPath = (wsId: string): string =>
  path.join(resolveLayoutDir(wsId), 'burndown.json');

/**
 * The latest published burndown, or null before the first publish. A file that exists but
 * does not hold a valid record throws: rendering it as "nothing published" would hide a fault.
 */
export const readBurndown = async (wsId: string): Promise<IBurndownRecord | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(resolveBurndownPath(wsId), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new BurndownStoreError(`burndown storage unreadable: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`);
  }
  let parsed: Partial<IBurndownRecord> | null;
  try {
    parsed = JSON.parse(raw) as Partial<IBurndownRecord> | null;
  } catch {
    throw new BurndownStoreError('burndown storage unreadable: the file is not JSON');
  }
  if (parsed?.workspaceId !== wsId) {
    throw new BurndownStoreError(`burndown storage unreadable: workspaceId saw ${JSON.stringify(parsed?.workspaceId)}, expected "${wsId}"`);
  }
  if (!Number.isSafeInteger(parsed.receivedAt)) {
    throw new BurndownStoreError('burndown storage unreadable: receivedAt is not an integer time');
  }
  const snapshot = parseBurndownSnapshot(parsed.snapshot, Number.MAX_SAFE_INTEGER);
  if (!snapshot.ok) throw new BurndownStoreError(`burndown storage unreadable: ${snapshot.error}`);
  return { workspaceId: wsId, receivedAt: parsed.receivedAt as number, snapshot: snapshot.snapshot };
};

export const writeBurndown = async (record: IBurndownRecord): Promise<void> =>
  withLock(record.workspaceId, async () => {
    const filePath = resolveBurndownPath(record.workspaceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpFile = `${filePath}.tmp`;
    try {
      await fs.writeFile(tmpFile, JSON.stringify(record), { mode: 0o600 });
      await fs.rename(tmpFile, filePath);
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {});
      throw err;
    }
  });
