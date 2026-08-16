import fs from 'fs/promises';
import { toSessionHistoryProvider } from '@/lib/agent-panel-types';
import path from 'path';
import os from 'os';
import { createLogger } from '@/lib/logger';
import type { ISessionHistoryEntry, ISessionHistoryData } from '@/types/session-history';

const log = createLogger('session-history');

const MAX_ENTRIES = 200;
const BASE_DIR = path.join(os.homedir(), '.purplemux');
const SESSION_HISTORY_FILE = path.join(BASE_DIR, 'session-history.json');

const g = globalThis as unknown as {
  __purplemuxSessionHistoryLock?: Promise<void>;
  __purplemuxSessionHistoryContentCache?: string;
  __ptSessionHistoryLegacyLogged?: boolean;
};
if (!g.__purplemuxSessionHistoryLock) g.__purplemuxSessionHistoryLock = Promise.resolve();

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__purplemuxSessionHistoryLock!;
  g.__purplemuxSessionHistoryLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const emptyData = (): ISessionHistoryData => ({ version: 1, entries: [] });

const migrateLegacyEntry = (raw: unknown): ISessionHistoryEntry | null => {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown> & Partial<ISessionHistoryEntry>;

  if (typeof e.id !== 'string' || typeof e.tabId !== 'string') return null;

  const providerId = toSessionHistoryProvider(typeof e.providerId === 'string' ? e.providerId : undefined);
  const agentSessionId =
    typeof e.agentSessionId === 'string' || e.agentSessionId === null
      ? (e.agentSessionId as string | null)
      : (typeof e.claudeSessionId === 'string' ? e.claudeSessionId : null);

  if (e.agentSessionId === undefined && e.claudeSessionId !== undefined && !g.__ptSessionHistoryLegacyLogged) {
    g.__ptSessionHistoryLegacyLogged = true;
    log.info('Migrating legacy session-history entries (claudeSessionId → agentSessionId)');
  }

  return {
    id: e.id,
    workspaceId: String(e.workspaceId ?? ''),
    workspaceName: String(e.workspaceName ?? ''),
    workspaceDir: typeof e.workspaceDir === 'string' || e.workspaceDir === null ? (e.workspaceDir as string | null) : null,
    tabId: e.tabId,
    providerId,
    agentSessionId,
    prompt: typeof e.prompt === 'string' || e.prompt === null ? (e.prompt as string | null) : null,
    result: typeof e.result === 'string' || e.result === null ? (e.result as string | null) : null,
    startedAt: Number(e.startedAt ?? 0),
    completedAt: Number(e.completedAt ?? 0),
    duration: Number(e.duration ?? 0),
    dismissedAt: typeof e.dismissedAt === 'number' || e.dismissedAt === null ? (e.dismissedAt as number | null) : null,
    toolUsage: (e.toolUsage as Record<string, number>) ?? {},
    touchedFiles: Array.isArray(e.touchedFiles) ? (e.touchedFiles as string[]) : [],
    ...(e.cancelled ? { cancelled: true } : {}),
  };
};

const readSessionHistory = async (): Promise<ISessionHistoryData> => {
  let raw: string;
  try {
    raw = await fs.readFile(SESSION_HISTORY_FILE, 'utf-8');
  } catch {
    return emptyData();
  }

  let parsed: { version?: number; entries?: unknown[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn('Failed to parse session-history.json, starting empty');
    try {
      await fs.copyFile(SESSION_HISTORY_FILE, SESSION_HISTORY_FILE.replace(/\.json$/, '.json.bak'));
    } catch {}
    return emptyData();
  }

  const entries: ISessionHistoryEntry[] = [];
  for (const entry of parsed.entries ?? []) {
    const migrated = migrateLegacyEntry(entry);
    if (migrated) entries.push(migrated);
  }
  return { version: 1, entries };
};

const stripDeprecatedFields = (entries: ISessionHistoryEntry[]): ISessionHistoryEntry[] =>
  entries.map((entry) => {
    const { claudeSessionId: _claudeSessionId, ...rest } = entry;
    void _claudeSessionId;
    return rest;
  });

const writeSessionHistory = async (data: ISessionHistoryData): Promise<void> => {
  const cleaned: ISessionHistoryData = { version: data.version, entries: stripDeprecatedFields(data.entries) };
  const contentKey = JSON.stringify(cleaned.entries);
  if (g.__purplemuxSessionHistoryContentCache === contentKey) return;

  const tmpFile = SESSION_HISTORY_FILE + '.tmp';
  try {
    await fs.writeFile(tmpFile, JSON.stringify(cleaned, null, 2), { mode: 0o600 });
    await fs.rename(tmpFile, SESSION_HISTORY_FILE);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }

  g.__purplemuxSessionHistoryContentCache = contentKey;
};

export const addSessionHistoryEntry = async (entry: ISessionHistoryEntry): Promise<void> => {
  await withLock(async () => {
    const data = await readSessionHistory();
    data.entries.unshift(entry);
    if (data.entries.length > MAX_ENTRIES) {
      data.entries = data.entries.slice(0, MAX_ENTRIES);
    }
    await writeSessionHistory(data);
  });
};

export const updateSessionHistoryDismissedAt = async (
  tabId: string,
  dismissedAt: number,
): Promise<ISessionHistoryEntry | null> => {
  return await withLock(async () => {
    const data = await readSessionHistory();
    const entry = data.entries.find((e) => e.tabId === tabId && e.dismissedAt === null);
    if (!entry) return null;
    entry.dismissedAt = dismissedAt;
    await writeSessionHistory(data);
    return entry;
  });
};

export const getSessionHistory = async (): Promise<ISessionHistoryEntry[]> => {
  const data = await readSessionHistory();
  return data.entries;
};
