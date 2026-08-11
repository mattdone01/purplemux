import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { resolveLayoutDir } from '@/lib/layout-store';
import { MAX_STANDUP_HISTORY } from '@/lib/standup';
import { createLogger } from '@/lib/logger';
import type { IWorkspaceStandup } from '@/types/status';

const log = createLogger('standup-store');

const WORKSPACES_DIR = path.join(os.homedir(), '.purplemux', 'workspaces');

interface IStandupFile {
  standups: IWorkspaceStandup[];
}

const g = globalThis as unknown as {
  __ptStandupLocks?: Map<string, Promise<void>>;
};
if (!g.__ptStandupLocks) g.__ptStandupLocks = new Map();

const withLock = async <T>(wsId: string, fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__ptStandupLocks!.get(wsId) ?? Promise.resolve();
  g.__ptStandupLocks!.set(wsId, next);
  await prev;
  try {
    return await fn();
  } finally {
    release!();
    if (g.__ptStandupLocks!.get(wsId) === next) {
      g.__ptStandupLocks!.delete(wsId);
    }
  }
};

const resolveStandupPath = (wsId: string): string =>
  path.join(resolveLayoutDir(wsId), 'standups.json');

const readFile = async (filePath: string): Promise<IWorkspaceStandup[]> => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as IStandupFile;
    return Array.isArray(parsed.standups) ? parsed.standups : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err: e }, 'failed to read');
    }
    return [];
  }
};

const writeFile = async (filePath: string, data: IStandupFile): Promise<void> => {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpFile = filePath + '.tmp';
  try {
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }
};

/** Newest first. */
export const readStandups = async (wsId: string): Promise<IWorkspaceStandup[]> =>
  readFile(resolveStandupPath(wsId));

export const addStandup = async (standup: IWorkspaceStandup): Promise<void> =>
  withLock(standup.workspaceId, async () => {
    const filePath = resolveStandupPath(standup.workspaceId);
    const standups = await readFile(filePath);
    standups.unshift(standup);
    if (standups.length > MAX_STANDUP_HISTORY) standups.length = MAX_STANDUP_HISTORY;
    await writeFile(filePath, { standups });
  });

/**
 * Latest standup per workspace, straight off disk. StatusManager hydrates its
 * in-memory map from this on boot so ticks survive a server restart — the whole
 * point of a standup is answering "where are things at" after you stepped away.
 */
export const readAllLatestStandups = async (): Promise<Record<string, IWorkspaceStandup>> => {
  let entries;
  try {
    entries = await fs.readdir(WORKSPACES_DIR, { withFileTypes: true });
  } catch {
    return {};
  }
  const result: Record<string, IWorkspaceStandup> = {};
  await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const standups = await readFile(path.join(WORKSPACES_DIR, e.name, 'standups.json'));
        if (standups[0]) result[e.name] = standups[0];
      }),
  );
  return result;
};
