import fs from 'fs/promises';
import { createHash } from 'crypto';
import { parseJsonlContent } from '@/lib/session-parser';
import { codexSessionIdFromJsonlPath, parseCodexContent } from '@/lib/session-parser-codex';
import type { TSessionProvider } from '@/lib/session-resolver';
import type { ITimelineEntry } from '@/types/timeline';

export const DEFAULT_HISTORY_LIMIT = 200;
export const MAX_HISTORY_LIMIT = 500;

/** Enough of a session to page; two providers, so two stores of the same size. */
const MAX_CACHED_SESSIONS = 64;
/** Second bound, on content rather than count: 64 huge sessions must not pin memory. */
const MAX_CACHED_ENTRIES = 50_000;
const MAX_TRACKED_REVISIONS = 256;
const HEAD_BYTES = 4096;
const TAIL_SCAN_BYTES = 65_536;
/** Past this, a session pages through byte windows instead of a whole-file parse. */
const MAX_FULL_PARSE_BYTES = 8_388_608;
const WINDOW_BYTES = 2_097_152;

export interface IHistoryPage {
  entries: ITimelineEntry[];
  /**
   * Cursor for the next call: the client passes it straight back as `afterSeq`.
   * One past the last delivered `seq` on a full page, and the incoming
   * `afterSeq` on an empty one, so polling an idle session never advances it.
   */
  nextSeq: number;
  hasMore: boolean;
  sessionRevision: string;
}

interface ISnapshot {
  /**
   * `inode:size:mtimeMs` — what the cached entries were parsed from. Distinct
   * from the revision on purpose: the revision survives an append, the parse
   * does not.
   */
  fingerprint: string;
  revision: string;
  entries: ITimelineEntry[];
}

interface IRevisionState {
  inode: number;
  size: number;
  headHash: string;
  generation: number;
}

interface IHistoryStores {
  __ptHistoryIndex?: Map<string, ISnapshot>;
  __ptCodexHistoryState?: Map<string, ISnapshot>;
  __ptHistoryRevisions?: Map<string, IRevisionState>;
}

const g = globalThis as unknown as IHistoryStores;
if (!g.__ptHistoryIndex) g.__ptHistoryIndex = new Map();
if (!g.__ptCodexHistoryState) g.__ptCodexHistoryState = new Map();
if (!g.__ptHistoryRevisions) g.__ptHistoryRevisions = new Map();

const claudeSnapshots = g.__ptHistoryIndex;
const codexSnapshots = g.__ptCodexHistoryState;
const revisions = g.__ptHistoryRevisions;

const snapshotStore = (provider: TSessionProvider): Map<string, ISnapshot> =>
  provider === 'codex' ? codexSnapshots : claudeSnapshots;

const touch = <T>(store: Map<string, T>, key: string): T | undefined => {
  const value = store.get(key);
  if (value === undefined) return undefined;
  store.delete(key);
  store.set(key, value);
  return value;
};

const evict = (store: Map<string, ISnapshot>) => {
  let entryCount = 0;
  for (const snapshot of store.values()) entryCount += snapshot.entries.length;

  while (store.size > MAX_CACHED_SESSIONS || (entryCount > MAX_CACHED_ENTRIES && store.size > 1)) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    entryCount -= store.get(oldest)?.entries.length ?? 0;
    store.delete(oldest);
  }
};

const readHead = async (filePath: string): Promise<string> => {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf-8');
    const newline = head.indexOf('\n');
    return newline >= 0 ? head.slice(0, newline) : head;
  } finally {
    await handle.close();
  }
};

/**
 * `inode:hash(first record):generation`.
 *
 * The client only compares it for equality, and restarts from `afterSeq=-1`
 * when it changes — so it must stay stable while the file only grows (an append
 * leaves every earlier `seq` valid) and must change when the file is rewritten
 * or compacted underneath a cursor. The first record covers a rewrite; the
 * generation counter covers a truncate that happens to keep it.
 */
const computeRevision = async (
  filePath: string,
): Promise<{ revision: string; fingerprint: string; size: number }> => {
  const stat = await fs.stat(filePath);
  const headHash = createHash('sha1').update(await readHead(filePath)).digest('hex').slice(0, 16);
  const previous = touch(revisions, filePath);

  const generation = previous && stat.size < previous.size && previous.inode === Number(stat.ino)
    ? previous.generation + 1
    : previous?.generation ?? 0;

  revisions.set(filePath, { inode: Number(stat.ino), size: stat.size, headHash, generation });
  while (revisions.size > MAX_TRACKED_REVISIONS) {
    const oldest = revisions.keys().next().value;
    if (oldest === undefined) break;
    revisions.delete(oldest);
  }

  return {
    revision: `${stat.ino}:${headHash}:${generation}`,
    fingerprint: `${stat.ino}:${stat.size}:${stat.mtimeMs}`,
    size: stat.size,
  };
};

const parseEntries = (
  content: string,
  byteBase: number,
  provider: TSessionProvider,
  jsonlPath: string,
): ITimelineEntry[] =>
  provider === 'codex'
    ? parseCodexContent(content, byteBase, codexSessionIdFromJsonlPath(jsonlPath))
    : parseJsonlContent(content, byteBase);

/**
 * Whole-file parse rather than `parseSessionFile`, which switches to tail mode
 * past 1 MB: history must be able to page from the first entry. The snapshot is
 * cached per revision, so paging a session costs one parse however many pages
 * the client walks.
 */
const readSnapshot = async (
  jsonlPath: string,
  provider: TSessionProvider,
  revision: string,
  fingerprint: string,
): Promise<ISnapshot> => {
  const store = snapshotStore(provider);
  const cached = touch(store, jsonlPath);
  if (cached && cached.fingerprint === fingerprint) return cached;

  const content = await fs.readFile(jsonlPath, 'utf-8');
  const snapshot: ISnapshot = {
    fingerprint,
    revision,
    entries: parseEntries(content, 0, provider, jsonlPath),
  };
  store.set(jsonlPath, snapshot);
  evict(store);
  return snapshot;
};

const seqOf = (entry: ITimelineEntry): number => entry.seq ?? -1;

/**
 * Reads `[from, to)` and trims both ends back to record boundaries, so what is
 * parsed is whole lines and `validFrom` is their absolute offset.
 */
const readWindow = async (
  filePath: string,
  from: number,
  to: number,
  fileSize: number,
): Promise<{ content: string; validFrom: number }> => {
  const handle = await fs.open(filePath, 'r');
  let raw: string;
  try {
    const buffer = Buffer.alloc(to - from);
    await handle.read(buffer, 0, buffer.length, from);
    raw = buffer.toString('utf-8');
  } finally {
    await handle.close();
  }

  let content = raw;
  let validFrom = from;
  if (from > 0) {
    const newline = raw.indexOf('\n');
    if (newline < 0) return { content: '', validFrom: to };
    content = raw.slice(newline + 1);
    validFrom = from + Buffer.byteLength(raw.slice(0, newline + 1), 'utf-8');
  }
  if (to < fileSize) {
    const lastNewline = content.lastIndexOf('\n');
    content = lastNewline < 0 ? '' : content.slice(0, lastNewline + 1);
  }

  return { content, validFrom };
};

/**
 * Paging for a session too large to hold parsed in memory. `seq` is the record's
 * own byte offset, so a window starting at the cursor yields the same ids and
 * seqs a whole-file parse would; a tool result whose call sits before the window
 * simply arrives unmerged, which is the entry the client already holds.
 */
const readWindowedEntries = async (
  jsonlPath: string,
  provider: TSessionProvider,
  afterSeq: number,
  fileSize: number,
): Promise<{ entries: ITimelineEntry[]; reachedEnd: boolean }> => {
  const from = afterSeq < 0 ? 0 : afterSeq;
  let windowSize = WINDOW_BYTES;

  while (true) {
    const to = Math.min(fileSize, from + windowSize);
    const { content, validFrom } = await readWindow(jsonlPath, from, to, fileSize);
    const entries = content
      ? parseEntries(content, validFrom, provider, jsonlPath).filter((entry) => seqOf(entry) > afterSeq)
      : [];

    if (entries.length > 0 || to >= fileSize) return { entries, reachedEnd: to >= fileSize };
    windowSize *= 2;
  }
};

export interface IHistoryPageRequest {
  jsonlPath: string;
  provider: TSessionProvider;
  afterSeq: number;
  limit: number;
}

/**
 * A record that yields several entries numbers them consecutively, and the next
 * record always starts further out than that. Ending a page on that run instead
 * of inside it makes `nextSeq = lastSeq + 1` a cursor that cannot skip an entry.
 */
const takePage = (
  candidates: ITimelineEntry[],
  limit: number,
): { entries: ITimelineEntry[]; truncated: boolean } => {
  let end = Math.min(limit, candidates.length);
  while (end < candidates.length && seqOf(candidates[end]) === seqOf(candidates[end - 1]) + 1) end++;
  return { entries: candidates.slice(0, end), truncated: end < candidates.length };
};

export const readHistoryPage = async ({
  jsonlPath,
  provider,
  afterSeq,
  limit,
}: IHistoryPageRequest): Promise<IHistoryPage | null> => {
  let revision: string;
  let fingerprint: string;
  let size: number;
  try {
    ({ revision, fingerprint, size } = await computeRevision(jsonlPath));
  } catch {
    return null;
  }

  let candidates: ITimelineEntry[];
  let reachedEnd = true;

  if (size <= MAX_FULL_PARSE_BYTES) {
    const { entries: all } = await readSnapshot(jsonlPath, provider, revision, fingerprint);
    const start = all.findIndex((entry) => seqOf(entry) > afterSeq);
    candidates = start === -1 ? [] : all.slice(start);
  } else {
    ({ entries: candidates, reachedEnd } = await readWindowedEntries(jsonlPath, provider, afterSeq, size));
  }

  if (candidates.length === 0) {
    return { entries: [], nextSeq: afterSeq, hasMore: !reachedEnd, sessionRevision: revision };
  }

  const { entries, truncated } = takePage(candidates, limit);

  return {
    entries,
    nextSeq: seqOf(entries[entries.length - 1]) + 1,
    hasMore: truncated || !reachedEnd,
    sessionRevision: revision,
  };
};

/**
 * `seq` of the session's last entry, for listings that must tell a client
 * whether its cache is behind without paging the whole session.
 *
 * Only the tail of the file is parsed, so a Codex entry whose correlated call
 * sits outside the window can be missed; the last record's own byte offset is
 * the floor, which keeps the value at or above every `seq` a synced client can
 * hold. An empty session is -1 — the same value `afterSeq` defaults to.
 */
export const readLastSeq = async (
  jsonlPath: string,
  provider: TSessionProvider,
): Promise<number> => {
  try {
    const stat = await fs.stat(jsonlPath);
    if (stat.size === 0) return -1;

    const from = Math.max(0, stat.size - TAIL_SCAN_BYTES);
    const handle = await fs.open(jsonlPath, 'r');
    let raw: string;
    try {
      const buffer = Buffer.alloc(stat.size - from);
      await handle.read(buffer, 0, buffer.length, from);
      raw = buffer.toString('utf-8');
    } finally {
      await handle.close();
    }

    let content = raw;
    let validFrom = from;
    if (from > 0) {
      const newline = raw.indexOf('\n');
      if (newline < 0) return -1;
      content = raw.slice(newline + 1);
      validFrom = from + Buffer.byteLength(raw.slice(0, newline + 1), 'utf-8');
    }

    let lastLineOffset = -1;
    let bytePos = validFrom;
    for (const line of content.split('\n')) {
      if (line.trim()) lastLineOffset = bytePos;
      bytePos += Buffer.byteLength(line, 'utf-8') + 1;
    }

    const entries = parseEntries(content, validFrom, provider, jsonlPath);
    const parsedMax = entries.reduce((max, entry) => Math.max(max, seqOf(entry)), -1);
    return Math.max(parsedMax, lastLineOffset);
  } catch {
    return -1;
  }
};
