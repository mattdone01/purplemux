import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { HOOK_SPOOL_DIRNAME } from '@/lib/hook-scripts';
import { HOOK_FLOORS_FILENAME } from '@/lib/hook-floors';
import type { IHookDelivery } from '@/lib/hook-dispatch';

const log = createLogger('hook-spool');

export const HOOK_SPOOL_DIR = path.join(os.homedir(), '.purplemux', HOOK_SPOOL_DIRNAME);
export const HOOK_SPOOL_BAD_DIRNAME = 'bad';
export const HOOK_SPOOL_MAX_FILES = 10_000;
/**
 * A spooled event older than this is dropped unreplayed (ADR-0020). A restart
 * gap is seconds to minutes; an older file may predate events that a server
 * without the spool applied live, and the poll and `resolveUnknown` recover the
 * state of a long outage from the process and the transcript instead.
 */
export const HOOK_REPLAY_WINDOW_MS = 60 * 60 * 1000;
/** `bad/` entries are evidence for a week, then pruned. */
export const HOOK_SPOOL_BAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A hook's temporary file this old belongs to a hook that died before its rename. */
export const HOOK_SPOOL_TMP_MAX_AGE_MS = 10 * 60 * 1000;
/** Files replayed between two yields to the event loop. */
const DRAIN_BATCH = 50;

/** One event a hook script could not deliver (`spool_hook` in `hook-scripts.ts`). */
export interface ISpooledHook {
  at: number;
  session: string;
  query: string;
  body: unknown;
  /** The hook kept only the metadata: the body was over the spool's size limit. */
  bodyDropped: boolean;
  bodyLength: number | null;
}

export interface IHookSpoolDrainResult {
  applied: number;
  bad: number;
  /** Past the replay window or over the file bound: deleted, never dispatched. */
  dropped: number;
  /** Written without its body (too large): deleted, never dispatched. */
  metadataOnly: number;
  prunedBad: number;
  prunedTmp: number;
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
  const { at, session, query, body, bodyDropped, bodyLength } = raw as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return null;
  if (typeof session !== 'string' || typeof query !== 'string' || !('body' in raw)) return null;
  return {
    at,
    session,
    query,
    body,
    bodyDropped: bodyDropped === true,
    bodyLength: typeof bodyLength === 'number' ? bodyLength : null,
  };
};

export const spooledHookQuery = (query: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(query));

interface ISpoolEntry {
  name: string;
  at: number;
}

interface ISpoolListing {
  entries: ISpoolEntry[];
  unnamed: string[];
  temporaries: string[];
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

const listSpool = async (dir: string): Promise<ISpoolListing> => {
  let dirents: import('fs').Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return { entries: [], unnamed: [], temporaries: [] };
    throw err;
  }
  const listing: ISpoolListing = { entries: [], unnamed: [], temporaries: [] };
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    // The server's own floors file (ADR-0020) is neither an event nor a temporary.
    if (dirent.name === HOOK_FLOORS_FILENAME) continue;
    // Other dot files are temporaries, still being written or orphaned.
    if (dirent.name.startsWith('.')) {
      listing.temporaries.push(dirent.name);
      continue;
    }
    const match = SPOOL_FILE.exec(dirent.name);
    if (match) listing.entries.push({ name: dirent.name, at: Number(match[1]) });
    else listing.unnamed.push(dirent.name);
  }
  listing.entries.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return listing;
};

const quarantine = async (dir: string, name: string, reason: string): Promise<void> => {
  const badDir = path.join(dir, HOOK_SPOOL_BAD_DIRNAME);
  await fs.mkdir(badDir, { recursive: true, mode: 0o700 });
  await fs.rename(path.join(dir, name), path.join(badDir, name));
  log.warn({ file: name, reason }, `spooled hook event moved to ${HOOK_SPOOL_BAD_DIRNAME}/: ${reason}`);
};

/** Remove every entry of `dir` whose mtime is older than `maxAgeMs`; returns how many. */
const pruneOlderThan = async (dir: string, names: string[], now: number, maxAgeMs: number): Promise<number> => {
  let pruned = 0;
  for (const name of names) {
    const target = path.join(dir, name);
    try {
      const stat = await fs.lstat(target);
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      await fs.rm(target, { recursive: true, force: true });
      pruned += 1;
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return pruned;
};

const pruneBad = async (dir: string, now: number): Promise<number> => {
  const badDir = path.join(dir, HOOK_SPOOL_BAD_DIRNAME);
  let names: string[];
  try {
    names = await fs.readdir(badDir);
  } catch (err) {
    if (isMissing(err)) return 0;
    throw err;
  }
  return pruneOlderThan(badDir, names, now, HOOK_SPOOL_BAD_MAX_AGE_MS);
};

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Replay the events hook scripts spooled while no server answered (ADR-0020).
 *
 * Oldest first, each through `apply` — the hook route's own dispatcher — with
 * its original time, and deleted once applied. A file that does not parse, or
 * whose replay throws, moves to `bad/` once and is never retried. Files past
 * the replay window, then the oldest beyond `maxFiles`, are deleted without
 * dispatch, with one log line; so is a file whose body the hook dropped for
 * size. `bad/` entries older than 7 days and orphaned temporaries older than
 * 10 minutes are pruned. The drain yields to the event loop every 50 files,
 * so the server keeps answering while a large spool drains.
 */
export const drainHookSpool = async (
  apply: (delivery: IHookDelivery) => Promise<unknown>,
  options: IHookSpoolDrainOptions = {},
): Promise<IHookSpoolDrainResult> => {
  const dir = options.dir ?? HOOK_SPOOL_DIR;
  const now = options.now ?? Date.now();
  const maxFiles = options.maxFiles ?? HOOK_SPOOL_MAX_FILES;
  const maxAgeMs = options.maxAgeMs ?? HOOK_REPLAY_WINDOW_MS;
  const result: IHookSpoolDrainResult = { applied: 0, bad: 0, dropped: 0, metadataOnly: 0, prunedBad: 0, prunedTmp: 0 };

  const { entries, unnamed, temporaries } = await listSpool(dir);
  result.prunedTmp = await pruneOlderThan(dir, temporaries, now, HOOK_SPOOL_TMP_MAX_AGE_MS);
  result.prunedBad = await pruneBad(dir, now);
  if (result.prunedTmp > 0 || result.prunedBad > 0) {
    log.info({ prunedTmp: result.prunedTmp, prunedBad: result.prunedBad }, 'hook spool pruned');
  }
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
    for (const entry of dropped) await fs.rm(path.join(dir, entry.name), { force: true });
    result.dropped = dropped.length;
    log.warn(
      { dropped: dropped.length, expired: entries.length - fresh.length, oldestAt: dropped[0].at, maxFiles, maxAgeMs },
      `hook spool: dropped ${dropped.length} event(s) past the replay window or the file bound, unreplayed`,
    );
  }

  let droppedBodyLength = 0;
  for (const [index, entry] of kept.entries()) {
    if (index > 0 && index % DRAIN_BATCH === 0) await yieldToEventLoop();
    const file = path.join(dir, entry.name);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf-8');
    } catch (err) {
      // Another drain (a second process on the same home) took it first.
      if (isMissing(err)) continue;
      throw err;
    }
    const spooled = parseSpooledHook(text);
    if (!spooled) {
      await quarantine(dir, entry.name, 'not a spooled hook event (JSON with at, session, query, body)');
      result.bad += 1;
      continue;
    }
    if (spooled.bodyDropped) {
      await fs.rm(file, { force: true });
      result.metadataOnly += 1;
      droppedBodyLength += spooled.bodyLength ?? 0;
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
    await fs.rm(file, { force: true });
    result.applied += 1;
  }
  if (result.metadataOnly > 0) {
    log.info({ metadataOnly: result.metadataOnly, droppedBodyLength }, `hook spool: ${result.metadataOnly} event(s) spooled without their body (too large), not replayed`);
  }
  if (result.applied > 0) {
    log.info({ applied: result.applied, from: kept[0].at, to: kept[kept.length - 1].at }, `replayed ${result.applied} spooled hook event(s)`);
  }
  return result;
};
