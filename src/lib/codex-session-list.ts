import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { createLogger } from '@/lib/logger';
import { readCodexSessionStats } from '@/lib/stats/jsonl-parser-codex';

const log = createLogger('codex-session-list');

const SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const DEFAULT_DAYS_BACK = 30;
const MAX_FIRST_MESSAGE_LENGTH = 200;
const MAX_LINES_FOR_FIRST_MESSAGE = 60;
const CACHE_TTL_MS = 30_000;
const META_DEDUP_LOG_KEYS = new Set<string>();

export interface ICodexSessionEntry {
  sessionId: string;
  jsonlPath: string;
  startedAt: number;
  lastActivityAt: number;
  cwd: string | null;
  model: string | null;
  firstUserMessage: string | null;
  turnCount: number;
  totalTokens: number | null;
}

interface ICodexCacheEntry {
  entry: ICodexSessionEntry;
  mtime: number;
  cachedAt: number;
}

const g = globalThis as unknown as { __ptCodexSessionMetaCache?: Map<string, ICodexCacheEntry> };
if (!g.__ptCodexSessionMetaCache) g.__ptCodexSessionMetaCache = new Map();
const cache = g.__ptCodexSessionMetaCache;

const truncateMessage = (text: string): string =>
  text.length <= MAX_FIRST_MESSAGE_LENGTH ? text : text.slice(0, MAX_FIRST_MESSAGE_LENGTH) + '…';

const warnOnce = (key: string, payload: Record<string, unknown>) => {
  if (META_DEDUP_LOG_KEYS.has(key)) return;
  META_DEDUP_LOG_KEYS.add(key);
  log.warn(payload, 'codex session meta failed');
};

interface ICodexSessionMetaPayload {
  id?: string;
  timestamp?: string;
  cwd?: string;
  model?: string;
}

interface ICodexUserMessagePayload {
  type?: string;
  message?: string;
}

const isDisplayableUserMessage = (text: string): boolean => {
  if (!text) return false;
  if (text.startsWith('<') && text.includes('environment_context')) return false;
  if (text.startsWith('<') && text.includes('user_instructions')) return false;
  return true;
};

const extractMeta = async (jsonlPath: string): Promise<ICodexSessionEntry | null> => {
  const stream = createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let session_id: string | null = null;
  let startedAtIso: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let firstUserMessage: string | null = null;
  let turnCount = 0;
  let lineCount = 0;
  let isFirstLine = true;
  let metaParsed = false;

  try {
    for await (const line of rl) {
      lineCount++;

      if (isFirstLine) {
        isFirstLine = false;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: { type?: string; payload?: ICodexSessionMetaPayload; timestamp?: string };
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          throw new Error('first-line-parse-failed');
        }
        if (parsed.type !== 'session_meta' || !parsed.payload) {
          throw new Error('first-line-not-session-meta');
        }
        const payload = parsed.payload;
        if (!payload.id) throw new Error('session-meta-missing-id');
        session_id = payload.id;
        const startedRaw = payload.timestamp ?? parsed.timestamp;
        startedAtIso = startedRaw ?? null;
        cwd = payload.cwd ?? null;
        model = payload.model ?? null;
        metaParsed = true;
        continue;
      }

      if (!line.includes('"user_message"')) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string; payload?: ICodexUserMessagePayload };
        if (parsed.type !== 'event_msg') continue;
        const payload = parsed.payload;
        if (!payload || payload.type !== 'user_message') continue;
        const text = typeof payload.message === 'string' ? payload.message.trim() : '';
        if (!isDisplayableUserMessage(text)) continue;
        turnCount++;
        if (!firstUserMessage && lineCount <= MAX_LINES_FOR_FIRST_MESSAGE) {
          firstUserMessage = truncateMessage(text);
        }
      } catch {}
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!metaParsed || !session_id) return null;

  const startedAt = startedAtIso ? new Date(startedAtIso).getTime() : 0;
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;

  return {
    sessionId: session_id,
    jsonlPath,
    startedAt,
    lastActivityAt: startedAt,
    cwd,
    model,
    firstUserMessage,
    turnCount,
    totalTokens: null,
  };
};

const getCachedEntry = async (jsonlPath: string): Promise<ICodexSessionEntry | null> => {
  let stat;
  try {
    stat = await fs.stat(jsonlPath);
  } catch (err) {
    warnOnce(`stat:${jsonlPath}`, { jsonlPath, err: err instanceof Error ? err.message : err });
    return null;
  }

  const cached = cache.get(jsonlPath);
  if (cached && cached.mtime === stat.mtimeMs && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.entry;
  }

  try {
    const entry = await extractMeta(jsonlPath);
    if (!entry) return null;
    const stats = await readCodexSessionStats(jsonlPath).catch(() => null);
    const enriched: ICodexSessionEntry = stats
      ? {
          ...entry,
          lastActivityAt: stat.mtimeMs,
          model: entry.model ?? stats.model,
          totalTokens: stats.totalTokens > 0 ? stats.totalTokens : null,
        }
      : { ...entry, lastActivityAt: stat.mtimeMs };
    cache.set(jsonlPath, { entry: enriched, mtime: stat.mtimeMs, cachedAt: Date.now() });
    return enriched;
  } catch (err) {
    warnOnce(`parse:${jsonlPath}`, { jsonlPath, err: err instanceof Error ? err.message : err });
    return null;
  }
};

const dayDirPath = (date: Date): string =>
  path.join(
    SESSIONS_ROOT,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );

interface IListCodexSessionsOptions {
  cwd: string;
  daysBack?: number;
}

interface IListCodexSessionsResult {
  sessions: ICodexSessionEntry[];
  scannedDirs: number;
  scannedFiles: number;
}

/**
 * Every rollout in the scan window, unfiltered. Attribution is the caller's
 * question — a workspace owns a session started anywhere UNDER one of its
 * directories, which an equality test on cwd cannot express.
 */
export const listAllCodexSessions = async (
  daysBack: number = DEFAULT_DAYS_BACK,
): Promise<ICodexSessionEntry[]> => (await scanCodexSessions(daysBack)).sessions;

export const listCodexSessions = async ({
  cwd,
  daysBack = DEFAULT_DAYS_BACK,
}: IListCodexSessionsOptions): Promise<IListCodexSessionsResult> => {
  const scanned = await scanCodexSessions(daysBack);
  return {
    sessions: scanned.sessions.filter((entry) => entry.cwd === cwd),
    scannedDirs: scanned.scannedDirs,
    scannedFiles: scanned.scannedFiles,
  };
};

const scanCodexSessions = async (daysBack: number): Promise<IListCodexSessionsResult> => {
  const sessions: ICodexSessionEntry[] = [];
  const today = new Date();
  let scannedDirs = 0;
  let scannedFiles = 0;

  const dayPaths: string[] = [];
  for (let i = 0; i < daysBack; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    dayPaths.push(dayDirPath(date));
  }

  const dirEntries: { dir: string; files: string[] }[] = [];
  for (const dir of dayPaths) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    scannedDirs++;
    const jsonlFiles = names.filter((n) => n.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) continue;
    dirEntries.push({ dir, files: jsonlFiles });
  }

  const allTasks: Promise<ICodexSessionEntry | null>[] = [];
  for (const { dir, files } of dirEntries) {
    for (const file of files) {
      scannedFiles++;
      allTasks.push(getCachedEntry(path.join(dir, file)));
    }
  }

  const results = await Promise.all(allTasks);
  for (const entry of results) {
    if (entry) sessions.push(entry);
  }

  sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return { sessions, scannedDirs, scannedFiles };
};

export interface ICodexSessionHead {
  sessionId: string | null;
  cwd: string | null;
}

const HEAD_BYTES = 8192;

/**
 * `session_meta` from the first record, without streaming the rest of the file.
 * A whole-corpus walk needs the cwd of every rollout to attribute it to a
 * workspace, and `extractMeta` pays for a full read to count turns.
 */
export const readCodexSessionHead = async (jsonlPath: string): Promise<ICodexSessionHead> => {
  let raw: string;
  try {
    const handle = await fs.open(jsonlPath, 'r');
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      raw = buffer.subarray(0, bytesRead).toString('utf-8');
    } finally {
      await handle.close();
    }
  } catch {
    return { sessionId: null, cwd: null };
  }

  const newline = raw.indexOf('\n');
  const firstLine = (newline >= 0 ? raw.slice(0, newline) : raw).trim();
  if (!firstLine) return { sessionId: null, cwd: null };

  try {
    const parsed = JSON.parse(firstLine) as { type?: string; payload?: ICodexSessionMetaPayload };
    if (parsed.type !== 'session_meta' || !parsed.payload) return { sessionId: null, cwd: null };
    return { sessionId: parsed.payload.id ?? null, cwd: parsed.payload.cwd ?? null };
  } catch {
    return { sessionId: null, cwd: null };
  }
};

const YEAR_MONTH_DAY_DEPTH = 3;

const walkSessionDir = async (dir: string, depth: number): Promise<string[]> => {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  if (depth === 0) {
    return dirents
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(dir, entry.name));
  }

  const nested = await Promise.all(
    dirents
      .filter((entry) => entry.isDirectory())
      .map((entry) => walkSessionDir(path.join(dir, entry.name), depth - 1)),
  );
  return nested.flat();
};

/**
 * Every rollout under `~/.codex/sessions`, whatever its date. `listCodexSessions`
 * walks a rolling window of day directories because a session picker only shows
 * recent work; a search that silently stopped 30 days back would report a wrong
 * `total`.
 */
export const listCodexSessionFiles = async (): Promise<string[]> =>
  walkSessionDir(SESSIONS_ROOT, YEAR_MONTH_DAY_DEPTH);

export const clearCodexSessionListCache = (): void => {
  cache.clear();
};
