import fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { codexProvider } from '@/lib/providers/codex';
import { getSessionPanePid, hasSession } from '@/lib/tmux';
import {
  holdCodexActiveGeneration,
  verifyCodexActiveRuntime,
} from '@/lib/providers/codex/launch-lifecycle';
import type { ITab } from '@/types/terminal';

const READ_CHUNK_BYTES = 64 * 1024;
const HEAD_IDENTITY_BYTES = 64 * 1024;
const SCAN_BUDGET_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const BOUNDARY_FINGERPRINT_BYTES = 4 * 1024;
const MAX_CACHE_ENTRIES = 128;

export type TCodexModelObservationSource = 'turn_context' | 'thread_settings_applied';
export type TCodexModelStatus = 'unpinned' | 'unknown' | 'match' | 'mismatch';
export type TCodexObservationScanState = 'complete' | 'scanning' | 'unavailable' | 'invalid-session';
export type TCodexModelStatusReason =
  | 'awaiting-first-turn'
  | 'scanning'
  | 'session-unavailable'
  | 'session-identity-mismatch'
  | 'observation-unavailable'
  | 'runtime-unavailable'
  | 'launch-pending'
  | 'launch-held'
  | 'lifecycle-unverified'
  | null;

export interface ICodexModelSettings {
  model: string | null;
  effort: string | null;
}

export interface ICodexObservedModelSettings extends ICodexModelSettings {
  source: TCodexModelObservationSource;
  timestamp: string | null;
  sessionId: string;
}

export interface ICodexModelObservation {
  observed: ICodexObservedModelSettings | null;
  latestTurn: ICodexObservedModelSettings | null;
  latestSettings: ICodexObservedModelSettings | null;
  scanState: TCodexObservationScanState;
  hasActivity: boolean;
}

export interface ICodexModelStatus {
  expected: ICodexModelSettings;
  observed: ICodexObservedModelSettings | null;
  latestTurn: ICodexObservedModelSettings | null;
  latestSettings: ICodexObservedModelSettings | null;
  scanState?: TCodexObservationScanState;
  hasActivity?: boolean;
  status: TCodexModelStatus;
  reason?: TCodexModelStatusReason;
}

export interface IGetCodexModelStatusOptions {
  runtimeAlive?: boolean;
}

export interface IReadCodexModelObservationOptions {
  minimumByteOffset?: number;
}

interface IStoredObservation extends ICodexObservedModelSettings {
  byteOffset: number;
}

interface IObservationCacheEntry {
  identity: string;
  sessionId: string;
  minimumByteOffset: number;
  mode: 'cold' | 'live';
  offset: number;
  backwardOffset: number;
  backwardLine: Buffer;
  tailComplete: boolean;
  backwardRightComplete: boolean;
  backwardDiscardingOversizedRecord: boolean;
  fileSize: number;
  mtimeMs: number;
  boundary: Buffer;
  pending: Buffer;
  discardingOversizedRecord: boolean;
  latestTurn: IStoredObservation | null;
  latestSettings: IStoredObservation | null;
  hasActivity: boolean;
}

interface IModelObservationGlobal {
  cache: Map<string, IObservationCacheEntry>;
  locks: Map<string, Promise<void>>;
}

interface IParsedRecord {
  observation: IStoredObservation | null;
  activity: boolean;
}

const g = globalThis as unknown as { __ptCodexModelObservation?: IModelObservationGlobal };
if (!g.__ptCodexModelObservation) {
  g.__ptCodexModelObservation = { cache: new Map(), locks: new Map() };
}
const state = g.__ptCodexModelObservation;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const copyObservation = (value: IStoredObservation | null): ICodexObservedModelSettings | null =>
  value
    ? {
        model: value.model,
        effort: value.effort,
        source: value.source,
        timestamp: value.timestamp,
        sessionId: value.sessionId,
      }
    : null;

const emptyObservation = (scanState: TCodexObservationScanState): ICodexModelObservation => ({
  observed: null,
  latestTurn: null,
  latestSettings: null,
  scanState,
  hasActivity: false,
});

const observationResult = (
  entry: IObservationCacheEntry,
  scanState: TCodexObservationScanState,
): ICodexModelObservation => {
  const effective = !entry.latestTurn
    ? entry.latestSettings
    : !entry.latestSettings
      ? entry.latestTurn
      : entry.latestTurn.byteOffset > entry.latestSettings.byteOffset
        ? entry.latestTurn
        : entry.latestSettings;
  return {
    observed: scanState === 'complete' ? copyObservation(effective) : null,
    latestTurn: copyObservation(entry.latestTurn),
    latestSettings: copyObservation(entry.latestSettings),
    scanState,
    hasActivity: entry.hasActivity,
  };
};

const fileIdentity = (stat: Awaited<ReturnType<FileHandle['stat']>>): string =>
  `${String(stat.dev)}:${String(stat.ino)}`;

const readSessionIdFromFirstRecord = async (handle: FileHandle, fileSize: number): Promise<string | null> => {
  const readLimit = Math.min(fileSize, HEAD_IDENTITY_BYTES);
  let pending = Buffer.alloc(0);
  let offset = 0;
  while (offset < readLimit) {
    const length = Math.min(READ_CHUNK_BYTES, readLimit - offset);
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(chunk, 0, length, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    const content = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
    const newline = content.indexOf(0x0a);
    if (newline >= 0) {
      pending = content.subarray(0, newline);
      break;
    }
    pending = content;
  }
  if (pending.length === 0 || pending.length >= HEAD_IDENTITY_BYTES) return null;
  try {
    const parsed = JSON.parse(pending.toString('utf8')) as { type?: unknown; payload?: { id?: unknown } };
    return parsed.type === 'session_meta' ? nonEmptyString(parsed.payload?.id) : null;
  } catch {
    return null;
  }
};

const parseRecord = (record: Buffer, sessionId: string, byteOffset: number): IParsedRecord => {
  if (record.length === 0) return { observation: null, activity: false };
  if (record.length > MAX_RECORD_BYTES) return { observation: null, activity: true };
  try {
    const parsed = JSON.parse(record.toString('utf8')) as {
      timestamp?: unknown;
      type?: unknown;
      payload?: {
        type?: unknown;
        model?: unknown;
        effort?: unknown;
        reasoning_effort?: unknown;
        thread_id?: unknown;
        thread_settings?: { model?: unknown; reasoning_effort?: unknown };
      };
    };
    const activity = parsed.type !== 'session_meta';
    const timestamp = nonEmptyString(parsed.timestamp);
    if (parsed.type === 'turn_context') {
      const model = nonEmptyString(parsed.payload?.model);
      const effort = nonEmptyString(parsed.payload?.effort) ?? nonEmptyString(parsed.payload?.reasoning_effort);
      return {
        observation: model || effort
          ? { model, effort, source: 'turn_context', timestamp, sessionId, byteOffset }
          : null,
        activity,
      };
    }
    if (parsed.type === 'event_msg' && parsed.payload?.type === 'thread_settings_applied') {
      const threadId = nonEmptyString(parsed.payload.thread_id);
      if (threadId && threadId !== sessionId) return { observation: null, activity };
      const model = nonEmptyString(parsed.payload.thread_settings?.model);
      const effort = nonEmptyString(parsed.payload.thread_settings?.reasoning_effort);
      return {
        observation: model || effort
          ? { model, effort, source: 'thread_settings_applied', timestamp, sessionId, byteOffset }
          : null,
        activity,
      };
    }
    return { observation: null, activity };
  } catch {
    return { observation: null, activity: true };
  }
};

const applyForwardRecord = (entry: IObservationCacheEntry, record: Buffer, byteOffset: number): void => {
  const parsed = parseRecord(record, entry.sessionId, byteOffset);
  entry.hasActivity ||= parsed.activity;
  if (parsed.observation?.source === 'turn_context') entry.latestTurn = parsed.observation;
  if (parsed.observation?.source === 'thread_settings_applied') entry.latestSettings = parsed.observation;
};

const consumeForwardChunk = (entry: IObservationCacheEntry, chunk: Buffer, chunkOffset: number): void => {
  let start = 0;
  while (start < chunk.length) {
    const newline = chunk.indexOf(0x0a, start);
    const end = newline >= 0 ? newline : chunk.length;
    const segment = chunk.subarray(start, end);
    if (!entry.discardingOversizedRecord) {
      if (entry.pending.length + segment.length > MAX_RECORD_BYTES) {
        entry.pending = Buffer.alloc(0);
        entry.discardingOversizedRecord = newline < 0;
        entry.hasActivity = true;
      } else {
        const recordOffset = chunkOffset + start - entry.pending.length;
        entry.pending = entry.pending.length === 0 ? Buffer.from(segment) : Buffer.concat([entry.pending, segment]);
        if (newline >= 0) {
          applyForwardRecord(entry, entry.pending, recordOffset);
          entry.pending = Buffer.alloc(0);
        }
      }
    } else if (newline >= 0) {
      entry.discardingOversizedRecord = false;
    }
    if (newline < 0) break;
    start = newline + 1;
  }
};

const applyBackwardRecord = (entry: IObservationCacheEntry, record: Buffer, byteOffset: number): void => {
  const parsed = parseRecord(record, entry.sessionId, byteOffset);
  entry.hasActivity ||= parsed.activity;
  if (parsed.observation?.source === 'turn_context' && !entry.latestTurn) entry.latestTurn = parsed.observation;
  if (parsed.observation?.source === 'thread_settings_applied' && !entry.latestSettings) {
    entry.latestSettings = parsed.observation;
  }
};

const consumeBackwardChunk = (entry: IObservationCacheEntry, chunk: Buffer, chunkOffset: number): void => {
  let end = chunk.length;
  while (end > 0) {
    const newline = chunk.lastIndexOf(0x0a, end - 1);
    const segmentStart = newline + 1;
    const segment = chunk.subarray(segmentStart, end);
    if (!entry.backwardDiscardingOversizedRecord) {
      if (segment.length + entry.backwardLine.length > MAX_RECORD_BYTES) {
        entry.backwardLine = Buffer.alloc(0);
        entry.backwardDiscardingOversizedRecord = true;
        entry.hasActivity = true;
      } else {
        entry.backwardLine = entry.backwardLine.length === 0
          ? Buffer.from(segment)
          : Buffer.concat([segment, entry.backwardLine]);
      }
    }
    if (newline >= 0) {
      if (entry.backwardRightComplete && !entry.backwardDiscardingOversizedRecord) {
        applyBackwardRecord(entry, entry.backwardLine, chunkOffset + segmentStart);
      }
      entry.backwardLine = Buffer.alloc(0);
      entry.backwardDiscardingOversizedRecord = false;
      entry.backwardRightComplete = true;
      end = newline;
    } else {
      break;
    }
  }
};

const readBoundary = async (handle: FileHandle, offset: number): Promise<Buffer> => {
  const start = Math.max(0, offset - BOUNDARY_FINGERPRINT_BYTES);
  const length = offset - start;
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return Buffer.from(buffer.subarray(0, bytesRead));
};

const endsWithNewline = async (handle: FileHandle, fileSize: number): Promise<boolean> => {
  if (fileSize === 0) return false;
  const byte = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(byte, 0, 1, fileSize - 1);
  return bytesRead === 1 && byte[0] === 0x0a;
};

const newCacheEntry = async (
  handle: FileHandle,
  identity: string,
  sessionId: string,
  fileSize: number,
  mtimeMs: number,
  minimumByteOffset: number,
): Promise<IObservationCacheEntry> => ({
  identity,
  sessionId,
  minimumByteOffset,
  mode: 'cold',
  offset: 0,
  backwardOffset: fileSize,
  backwardLine: Buffer.alloc(0),
  tailComplete: await endsWithNewline(handle, fileSize),
  backwardRightComplete: false,
  backwardDiscardingOversizedRecord: false,
  fileSize,
  mtimeMs,
  boundary: Buffer.alloc(0),
  pending: Buffer.alloc(0),
  discardingOversizedRecord: false,
  latestTurn: null,
  latestSettings: null,
  hasActivity: false,
});

const rememberEntry = (jsonlPath: string, entry: IObservationCacheEntry): void => {
  state.cache.delete(jsonlPath);
  state.cache.set(jsonlPath, entry);
  while (state.cache.size > MAX_CACHE_ENTRIES) {
    const oldest = state.cache.keys().next().value as string | undefined;
    if (!oldest) break;
    state.cache.delete(oldest);
  }
};

const canReuseCache = async (
  handle: FileHandle,
  cached: IObservationCacheEntry | undefined,
  identity: string,
  sessionId: string,
  fileSize: number,
  mtimeMs: number,
  minimumByteOffset: number,
): Promise<boolean> => {
  if (!cached || cached.identity !== identity || cached.sessionId !== sessionId
    || cached.minimumByteOffset !== minimumByteOffset) return false;
  if (fileSize < cached.fileSize || (fileSize === cached.fileSize && mtimeMs !== cached.mtimeMs)) return false;
  if (cached.mode === 'cold' && fileSize !== cached.fileSize) return false;
  const boundaryOffset = cached.mode === 'live' ? cached.offset : cached.fileSize;
  return (await readBoundary(handle, boundaryOffset)).equals(cached.boundary);
};

const scanCold = async (handle: FileHandle, entry: IObservationCacheEntry): Promise<TCodexObservationScanState> => {
  let remaining = SCAN_BUDGET_BYTES;
  while (entry.backwardOffset > entry.minimumByteOffset && remaining > 0) {
    const length = Math.min(
      READ_CHUNK_BYTES,
      entry.backwardOffset - entry.minimumByteOffset,
      remaining,
    );
    const start = entry.backwardOffset - length;
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(chunk, 0, length, start);
    if (bytesRead === 0) break;
    consumeBackwardChunk(entry, chunk.subarray(0, bytesRead), start);
    entry.backwardOffset = start;
    remaining -= bytesRead;
  }
  const foundEffective = Boolean(entry.latestTurn || entry.latestSettings);
  if (entry.tailComplete && (foundEffective || entry.backwardOffset === entry.minimumByteOffset)) {
    entry.mode = 'live';
    entry.offset = entry.fileSize;
    entry.pending = Buffer.alloc(0);
    entry.discardingOversizedRecord = false;
    return 'complete';
  }
  return 'scanning';
};

const scanLive = async (
  handle: FileHandle,
  entry: IObservationCacheEntry,
  scanLimit: number,
): Promise<TCodexObservationScanState> => {
  let remaining = SCAN_BUDGET_BYTES;
  while (entry.offset < scanLimit && remaining > 0) {
    const length = Math.min(READ_CHUNK_BYTES, scanLimit - entry.offset, remaining);
    const chunk = Buffer.allocUnsafe(length);
    const chunkOffset = entry.offset;
    const { bytesRead } = await handle.read(chunk, 0, length, chunkOffset);
    if (bytesRead === 0) break;
    consumeForwardChunk(entry, chunk.subarray(0, bytesRead), chunkOffset);
    entry.offset += bytesRead;
    remaining -= bytesRead;
  }
  return entry.offset === scanLimit && entry.pending.length === 0 && !entry.discardingOversizedRecord
    ? 'complete'
    : 'scanning';
};

const readUnlocked = async (
  jsonlPath: string,
  sessionId: string,
  options: IReadCodexModelObservationOptions,
): Promise<ICodexModelObservation> => {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(jsonlPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return emptyObservation('unavailable');
    const minimumByteOffset = Math.max(0, Math.trunc(options.minimumByteOffset ?? 0));
    if (minimumByteOffset > stat.size) return emptyObservation('unavailable');
    const metadataSessionId = await readSessionIdFromFirstRecord(handle, stat.size);
    if (metadataSessionId !== sessionId) {
      state.cache.delete(jsonlPath);
      return emptyObservation('invalid-session');
    }

    const identity = fileIdentity(stat);
    const cached = state.cache.get(jsonlPath);
    const reusable = await canReuseCache(
      handle,
      cached,
      identity,
      sessionId,
      stat.size,
      stat.mtimeMs,
      minimumByteOffset,
    );
    const entry = reusable && cached
      ? cached
      : await newCacheEntry(handle, identity, sessionId, stat.size, stat.mtimeMs, minimumByteOffset);
    const scanState = entry.mode === 'cold'
      ? await scanCold(handle, entry)
      : await scanLive(handle, entry, stat.size);
    entry.fileSize = stat.size;
    entry.mtimeMs = stat.mtimeMs;
    entry.boundary = await readBoundary(handle, entry.mode === 'live' ? entry.offset : stat.size);
    rememberEntry(jsonlPath, entry);
    return observationResult(entry, scanState);
  } catch {
    return emptyObservation('unavailable');
  } finally {
    await handle?.close().catch(() => {});
  }
};

const withPathLock = async <T>(jsonlPath: string, work: () => Promise<T>): Promise<T> => {
  const previous = state.locks.get(jsonlPath) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.then(() => gate);
  state.locks.set(jsonlPath, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (state.locks.get(jsonlPath) === current) state.locks.delete(jsonlPath);
  }
};

export const readCodexModelObservation = async (
  jsonlPath: string,
  sessionId: string,
  options: IReadCodexModelObservationOptions = {},
): Promise<ICodexModelObservation> =>
  withPathLock(jsonlPath, () => readUnlocked(jsonlPath, sessionId, options));

export const compareCodexModelSettings = (
  expected: ICodexModelSettings,
  observed: ICodexObservedModelSettings | null,
): TCodexModelStatus => {
  if (!expected.model && !expected.effort) return 'unpinned';
  if (!observed) return 'unknown';
  if (expected.model && observed.model && expected.model !== observed.model) return 'mismatch';
  if (expected.effort && observed.effort && expected.effort !== observed.effort) return 'mismatch';
  if ((expected.model && !observed.model) || (expected.effort && !observed.effort)) return 'unknown';
  return 'match';
};

const isCodexRuntimeAlive = async (tab: ITab): Promise<boolean> => {
  try {
    if (!(await hasSession(tab.sessionName))) return false;
    const panePid = await getSessionPanePid(tab.sessionName);
    return panePid !== null && await codexProvider.isAgentRunning(panePid);
  } catch {
    return false;
  }
};

export const getCodexModelStatus = async (
  tab: ITab,
  options: IGetCodexModelStatusOptions = {},
): Promise<ICodexModelStatus> => {
  const expected: ICodexModelSettings = {
    model: nonEmptyString(tab.agentLaunchConfig?.model),
    effort: nonEmptyString(tab.agentLaunchConfig?.effort),
  };
  const launchRuntime = tab.codexLaunchRuntime;
  if (launchRuntime?.pending) {
    return {
      expected,
      ...emptyObservation('unavailable'),
      status: 'unknown',
      reason: launchRuntime.pending.phase === 'held' ? 'launch-held' : 'launch-pending',
    };
  }
  const activeLaunch = launchRuntime?.active;
  if (activeLaunch?.phase === 'held') {
    return { expected, ...emptyObservation('unavailable'), status: 'unknown', reason: 'launch-held' };
  }
  if (!expected.model && !expected.effort) {
    return { expected, ...emptyObservation('unavailable'), status: 'unpinned', reason: null };
  }

  const verifiedActive = activeLaunch ? await verifyCodexActiveRuntime(tab) : null;
  if (activeLaunch && !verifiedActive?.ok) {
    await holdCodexActiveGeneration(
      activeLaunch.workspaceId,
      activeLaunch.tabId,
      activeLaunch.generation,
      verifiedActive?.reason ?? 'runtime-unavailable',
    ).catch(() => {});
    return { expected, ...emptyObservation('unavailable'), status: 'unknown', reason: 'launch-held' };
  }
  const runtimeAlive = activeLaunch ? true : options.runtimeAlive ?? await isCodexRuntimeAlive(tab);
  if (!runtimeAlive) {
    return { expected, ...emptyObservation('unavailable'), status: 'unknown', reason: 'runtime-unavailable' };
  }

  const sessionId = codexProvider.readSessionId(tab);
  const jsonlPath = codexProvider.readJsonlPath(tab);
  if (!sessionId && !jsonlPath) {
    return {
      expected,
      ...emptyObservation('unavailable'),
      status: 'unknown',
      reason: activeLaunch ? 'awaiting-first-turn' : 'lifecycle-unverified',
    };
  }
  if (!sessionId || !jsonlPath) {
    return { expected, ...emptyObservation('unavailable'), status: 'unknown', reason: 'session-unavailable' };
  }

  const pathSessionId = codexProvider.sessionIdFromJsonlPath(jsonlPath);
  if (pathSessionId && pathSessionId !== sessionId) {
    return {
      expected,
      ...emptyObservation('invalid-session'),
      status: 'unknown',
      reason: 'session-identity-mismatch',
    };
  }

  const boundary = activeLaunch?.observationBoundary;
  if (activeLaunch?.resumeSessionId) {
    if (sessionId !== activeLaunch.resumeSessionId) {
      return {
        expected,
        ...emptyObservation('invalid-session'),
        status: 'unknown',
        reason: 'session-identity-mismatch',
      };
    }
    if (!boundary || boundary.sessionId !== sessionId || boundary.jsonlPath !== jsonlPath) {
      return {
        expected,
        ...emptyObservation('unavailable'),
        status: 'unknown',
        reason: 'observation-unavailable',
      };
    }
  }

  const observation = await readCodexModelObservation(jsonlPath, sessionId, {
    minimumByteOffset: boundary?.byteOffset,
  });
  if (observation.scanState !== 'complete') {
    const reason: TCodexModelStatusReason = observation.scanState === 'scanning'
      ? 'scanning'
      : observation.scanState === 'invalid-session'
        ? 'session-identity-mismatch'
        : 'session-unavailable';
    return { expected, ...observation, status: 'unknown', reason };
  }
  if (!observation.observed) {
    return {
      expected,
      ...observation,
      status: 'unknown',
      reason: observation.hasActivity ? 'observation-unavailable' : 'awaiting-first-turn',
    };
  }
  return {
    expected,
    ...observation,
    status: compareCodexModelSettings(expected, observation.observed),
    reason: null,
  };
};

export const clearCodexModelObservationCache = (): void => {
  state.cache.clear();
  state.locks.clear();
};
