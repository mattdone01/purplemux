import fs from 'fs/promises';
import path from 'path';
import { resolveLayoutDir } from '@/lib/layout-store';
import { appendFlowHistory, flowHistoryRow, parseFlowRecord } from '@/lib/flow';
import { createLogger } from '@/lib/logger';
import type { IFlowRecord, IFlowSnapshot } from '@/types/flow';

const log = createLogger('flow-store');

export type TFlowStoreErrorCode = 'flow-unreadable' | 'flow-write-failed';

/**
 * `damaged`: the file was read but does not hold a valid record, so the next publish may move it
 * aside. Otherwise the file could not be read at all and is left alone.
 */
export class FlowStoreError extends Error {
  readonly damaged: boolean;
  readonly code: TFlowStoreErrorCode;

  constructor(message: string, damaged: boolean, code: TFlowStoreErrorCode = 'flow-unreadable') {
    super(message);
    this.name = 'FlowStoreError';
    this.damaged = damaged;
    this.code = code;
  }
}

/** A write-side filesystem failure, coded so the caller never sees an uncoded 500. */
const writing = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    throw new FlowStoreError(
      `flow storage write failed (${step}): ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`, false, 'flow-write-failed');
  }
};

interface ICachedFlow {
  key: string;
  record: IFlowRecord;
}

const g = globalThis as unknown as {
  __ptFlowLocks?: Map<string, Promise<void>>;
  __ptFlowReadCache?: Map<string, ICachedFlow>;
};
if (!g.__ptFlowLocks) g.__ptFlowLocks = new Map();
if (!g.__ptFlowReadCache) g.__ptFlowReadCache = new Map();

const withLock = async <T>(wsId: string, fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__ptFlowLocks!.get(wsId) ?? Promise.resolve();
  g.__ptFlowLocks!.set(wsId, next);
  await prev;
  try {
    return await fn();
  } finally {
    release!();
    if (g.__ptFlowLocks!.get(wsId) === next) {
      g.__ptFlowLocks!.delete(wsId);
    }
  }
};

const resolveFlowPath = (wsId: string): string =>
  path.join(resolveLayoutDir(wsId), 'flow.json');

const cacheKey = (stat: { mtimeMs: number; size: number }): string => `${stat.mtimeMs}:${stat.size}`;

const unreadable = (error: unknown): FlowStoreError =>
  new FlowStoreError(`flow storage unreadable: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`, false);

/**
 * The latest published flow record, or null before the first publish. A file that exists but does
 * not hold a valid record throws: rendering it as "no flow published" would hide a fault. The
 * parsed record is cached by mtime and size; callers must not mutate it.
 */
export const readFlow = async (wsId: string): Promise<IFlowRecord | null> => {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(resolveFlowPath(wsId), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw unreadable(error);
  }
  try {
    let key: string;
    let raw: string;
    try {
      key = cacheKey(await handle.stat());
      const cached = g.__ptFlowReadCache!.get(wsId);
      if (cached?.key === key) return cached.record;
      raw = await handle.readFile('utf-8');
    } catch (error) {
      throw unreadable(error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new FlowStoreError('flow storage unreadable: the file is not JSON', true);
    }
    const result = parseFlowRecord(parsed, wsId);
    if (!result.ok) throw new FlowStoreError(`flow storage unreadable: ${result.error}`, true);
    g.__ptFlowReadCache!.set(wsId, { key, record: result.record });
    return result.record;
  } finally {
    await handle.close();
  }
};

export interface IFlowPublishResult {
  record: IFlowRecord;
  /** A damaged record was kept as `flow.json.corrupt-<receivedAt>` and the history starts again. */
  historyReset: boolean;
  bytes: number;
}

/**
 * Store `snapshot` as the workspace's newest flow and append the history row the server derives
 * from it. A damaged record is first hard-linked aside, never overwritten; the final rename then
 * replaces it in one step, so a reader never finds `flow.json` missing.
 */
export const publishFlow = async (wsId: string, snapshot: IFlowSnapshot, receivedAt: number): Promise<IFlowPublishResult> =>
  withLock(wsId, async () => {
    const filePath = resolveFlowPath(wsId);
    let previous: IFlowRecord | null = null;
    let historyReset = false;
    try {
      previous = await readFlow(wsId);
    } catch (error) {
      if (!(error instanceof FlowStoreError && error.damaged)) throw error;
      const aside = `${filePath}.corrupt-${receivedAt}`;
      await writing('keep aside', () => fs.link(filePath, aside));
      log.warn({ workspaceId: wsId, aside, reason: error.message }, 'kept a damaged flow record aside');
      historyReset = true;
    }
    const record = appendFlowHistory(
      { workspaceId: wsId, receivedAt, snapshot, history: previous?.history ?? [] },
      flowHistoryRow(snapshot, receivedAt),
    );
    const text = JSON.stringify(record);
    await writing('mkdir', () => fs.mkdir(path.dirname(filePath), { recursive: true }));
    const tmpFile = `${filePath}.tmp`;
    try {
      await writing('write', () => fs.writeFile(tmpFile, text, { mode: 0o600 }));
      await writing('rename', () => fs.rename(tmpFile, filePath));
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {});
      throw err;
    }
    g.__ptFlowReadCache!.set(wsId, { key: cacheKey(await fs.stat(filePath)), record });
    return { record, historyReset, bytes: Buffer.byteLength(text) };
  });
