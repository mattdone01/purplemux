import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { HOOK_SPOOL_DIRNAME } from '@/lib/hook-scripts';
import type { IHookDelivery } from '@/lib/hook-dispatch';

const log = createLogger('hook-spool');

export const HOOK_SPOOL_DIR = path.join(os.homedir(), '.purplemux', HOOK_SPOOL_DIRNAME);
export const HOOK_SPOOL_BAD_DIRNAME = 'bad';
export const HOOK_SPOOL_MAX_FILES = 10_000;
export const HOOK_SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One event a hook script could not deliver (`spool_hook` in `hook-scripts.ts`). */
export interface ISpooledHook {
  at: number;
  session: string;
  query: string;
  body: unknown;
}

export interface IHookSpoolDrainResult {
  applied: number;
  bad: number;
  dropped: number;
}

export interface IHookSpoolDrainOptions {
  dir?: string;
  now?: number;
  maxFiles?: number;
  maxAgeMs?: number;
}

const SPOOL_FILE = /^(\d{1,16})-[^/]*\.json$/;

export const parseSpooledHook = (text: string): ISpooledHook | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { at, session, query, body } = raw as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return null;
  if (typeof session !== 'string' || typeof query !== 'string' || !('body' in raw)) return null;
  return { at, session, query, body };
};

export const spooledHookQuery = (query: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(query));

interface ISpoolEntry {
  name: string;
  at: number;
}

const listSpool = async (dir: string): Promise<{ entries: ISpoolEntry[]; unnamed: string[] }> => {
  let dirents: import('fs').Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], unnamed: [] };
    throw err;
  }
  const entries: ISpoolEntry[] = [];
  const unnamed: string[] = [];
  for (const dirent of dirents) {
    // Dot files are a hook's temporaries, still being written.
    if (!dirent.isFile() || dirent.name.startsWith('.')) continue;
    const match = SPOOL_FILE.exec(dirent.name);
    if (match) entries.push({ name: dirent.name, at: Number(match[1]) });
    else unnamed.push(dirent.name);
  }
  entries.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries, unnamed };
};

const quarantine = async (dir: string, name: string, reason: string): Promise<void> => {
  const badDir = path.join(dir, HOOK_SPOOL_BAD_DIRNAME);
  await fs.mkdir(badDir, { recursive: true, mode: 0o700 });
  await fs.rename(path.join(dir, name), path.join(badDir, name));
  log.warn({ file: name, reason }, `spooled hook event moved to ${HOOK_SPOOL_BAD_DIRNAME}/: ${reason}`);
};

const removeQuietly = async (file: string): Promise<void> => {
  await fs.rm(file, { force: true });
};

/**
 * Replay the events hook scripts spooled while no server answered (ADR-0020).
 *
 * Oldest first, each through `apply` — the hook route's own dispatcher — with
 * its original time, and deleted once applied. A file that does not parse, or
 * whose replay throws, moves to `bad/` so it is kept and never retried in a
 * loop. The spool is bounded: files past `maxAgeMs`, then the oldest beyond
 * `maxFiles`, are dropped with one log line.
 */
export const drainHookSpool = async (
  apply: (delivery: IHookDelivery) => Promise<unknown>,
  options: IHookSpoolDrainOptions = {},
): Promise<IHookSpoolDrainResult> => {
  const dir = options.dir ?? HOOK_SPOOL_DIR;
  const now = options.now ?? Date.now();
  const maxFiles = options.maxFiles ?? HOOK_SPOOL_MAX_FILES;
  const maxAgeMs = options.maxAgeMs ?? HOOK_SPOOL_MAX_AGE_MS;
  const result: IHookSpoolDrainResult = { applied: 0, bad: 0, dropped: 0 };

  const { entries, unnamed } = await listSpool(dir);
  for (const name of unnamed) {
    await quarantine(dir, name, 'name is not <epoch-ms>-<pid>-<rand>.json');
    result.bad += 1;
  }
  if (entries.length === 0) return result;

  const fresh = entries.filter((entry) => now - entry.at <= maxAgeMs);
  const kept = fresh.slice(Math.max(0, fresh.length - maxFiles));
  const keptNames = new Set(kept.map((entry) => entry.name));
  const dropped = entries.filter((entry) => !keptNames.has(entry.name));
  if (dropped.length > 0) {
    for (const entry of dropped) await removeQuietly(path.join(dir, entry.name));
    result.dropped = dropped.length;
    log.warn(
      { dropped: dropped.length, oldestAt: dropped[0].at, newestDroppedAt: dropped[dropped.length - 1].at, maxFiles, maxAgeMs },
      `hook spool over its bound: dropped ${dropped.length} oldest event(s) unreplayed`,
    );
  }

  for (const entry of kept) {
    const file = path.join(dir, entry.name);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf-8');
    } catch (err) {
      // Another drain (a second process on the same home) took it first.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const spooled = parseSpooledHook(text);
    if (!spooled) {
      await quarantine(dir, entry.name, 'not a spooled hook event (JSON with at, session, query, body)');
      result.bad += 1;
      continue;
    }
    try {
      // A hook clock ahead of the server's must not date an event in the future.
      await apply({ query: spooledHookQuery(spooled.query), body: spooled.body, replayedAt: Math.min(spooled.at, now) });
    } catch (err) {
      await quarantine(dir, entry.name, `replay threw: ${err instanceof Error ? err.message : String(err)}`);
      result.bad += 1;
      continue;
    }
    await removeQuietly(file);
    result.applied += 1;
  }
  if (result.applied > 0) {
    log.info({ applied: result.applied, from: kept[0].at, to: kept[kept.length - 1].at }, `replayed ${result.applied} spooled hook event(s)`);
  }
  return result;
};
