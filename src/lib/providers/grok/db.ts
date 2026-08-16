import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { createLogger } from '@/lib/logger';

const log = createLogger('grok-db');

/**
 * grok-cli hard-codes `os.homedir()/.grok` (`src/storage/db.ts`), so there is no
 * config-dir override to key a store per workspace. See ADR-0005.
 */
export const GROK_HOME = path.join(os.homedir(), '.grok');
export const GROK_DB_PATH = path.join(GROK_HOME, 'grok.db');

export type TGrokParam = string | number | null;

export interface IGrokDatabase {
  all<T>(sql: string, ...params: TGrokParam[]): T[];
  get<T>(sql: string, ...params: TGrokParam[]): T | null;
  close(): void;
}

const g = globalThis as unknown as {
  __ptGrokDb?: { path: string; handle: DatabaseSync } | null;
};

const wrap = (handle: DatabaseSync): IGrokDatabase => ({
  all: <T>(sql: string, ...params: TGrokParam[]) => handle.prepare(sql).all(...params) as T[],
  get: <T>(sql: string, ...params: TGrokParam[]) => (handle.prepare(sql).get(...params) ?? null) as T | null,
  close: () => handle.close(),
});

/**
 * Resolved on first use rather than imported at module load: `node:sqlite`
 * prints a one-off ExperimentalWarning the moment it is loaded, and an install
 * that never opens a grok tab should never see it.
 */
const loadSqlite = () => process.getBuiltinModule('node:sqlite');

const openReadOnly = (dbPath: string): DatabaseSync | null => {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new (loadSqlite().DatabaseSync)(dbPath, { readOnly: true });
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : err, dbPath }, 'grok.db open failed');
    return null;
  }
};

/**
 * Opens a grok store read-only, without touching the shared handle. purplemux
 * never writes to grok's database: a write would race grok's own WAL writer.
 */
export const openGrokDatabase = (dbPath: string): IGrokDatabase | null => {
  const handle = openReadOnly(dbPath);
  return handle ? wrap(handle) : null;
};

/**
 * Process-wide handle on the default store, cached on `globalThis` so a Next.js
 * module reload does not leak SQLite connections.
 */
export const getGrokDatabase = (dbPath: string = GROK_DB_PATH): IGrokDatabase | null => {
  const cached = g.__ptGrokDb;
  if (cached && cached.path === dbPath) return wrap(cached.handle);
  if (cached) closeGrokDatabase();

  const handle = openReadOnly(dbPath);
  if (!handle) return null;
  g.__ptGrokDb = { path: dbPath, handle };
  return wrap(handle);
};

export const closeGrokDatabase = (): void => {
  const cached = g.__ptGrokDb;
  if (!cached) return;
  g.__ptGrokDb = null;
  try {
    cached.handle.close();
  } catch {
    // already closed
  }
};

export const grokStoreExists = (dbPath: string = GROK_DB_PATH): boolean => fs.existsSync(dbPath);
