import fs from 'fs/promises';
import path from 'path';
import { listGrokHomes, workspaceIdForGrokHome } from '@/lib/grok-home';
import {
  GROK_CWD_MARKER_FILENAME,
  GROK_SIGNALS_FILENAME,
  GROK_SUMMARY_FILENAME,
  GROK_UPDATES_FILENAME,
  grokSessionsRoot,
} from '@/lib/providers/grok/paths';

/** Grok mints UUIDv7 ids, and an ACP client may supply its own UUID with `-s`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isValidGrokSessionId = (id: unknown): id is string =>
  typeof id === 'string' && UUID_RE.test(id);

export interface IGrokSessionSummary {
  sessionId: string;
  cwd: string | null;
  title: string | null;
  model: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
}

export interface IGrokSessionRef {
  sessionId: string;
  home: string;
  /** null for the unscoped `~/.grok`; the owning workspace otherwise. */
  workspaceId: string | null;
  sessionDir: string;
  jsonlPath: string;
  cwd: string | null;
  lastActivityMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return null;
  }
};

/**
 * `summary.json` is the session's index entry (`17-sessions.md`, "Session
 * Metadata"): `info.id`, `info.cwd`, timestamps, counts and the model.
 */
export const readGrokSummary = async (sessionDir: string): Promise<IGrokSessionSummary | null> => {
  const parsed = await readJson(path.join(sessionDir, GROK_SUMMARY_FILENAME));
  if (!isRecord(parsed)) return null;
  const info = isRecord(parsed.info) ? parsed.info : {};
  const sessionId = asString(info.id) ?? path.basename(sessionDir);

  return {
    sessionId,
    cwd: asString(info.cwd),
    title: asString(parsed.generated_title) ?? asString(parsed.session_summary),
    model: asString(parsed.current_model_id),
    createdAt: asString(parsed.created_at),
    updatedAt: asString(parsed.last_active_at) ?? asString(parsed.updated_at),
    messageCount: typeof parsed.num_messages === 'number' ? parsed.num_messages : 0,
  };
};

export interface IGrokSignals {
  turnCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  toolsUsed: string[];
  primaryModelId: string | null;
}

export const readGrokSignals = async (sessionDir: string): Promise<IGrokSignals | null> => {
  const parsed = await readJson(path.join(sessionDir, GROK_SIGNALS_FILENAME));
  if (!isRecord(parsed)) return null;
  const count = (key: string): number => (typeof parsed[key] === 'number' ? parsed[key] as number : 0);
  return {
    turnCount: count('turnCount'),
    userMessageCount: count('userMessageCount'),
    assistantMessageCount: count('assistantMessageCount'),
    toolCallCount: count('toolCallCount'),
    toolsUsed: Array.isArray(parsed.toolsUsed)
      ? parsed.toolsUsed.filter((tool): tool is string => typeof tool === 'string')
      : [],
    primaryModelId: asString(parsed.primaryModelId),
  };
};

/**
 * The working directory a session group is named after.
 *
 * Grok URL-encodes the cwd into the group's directory name, and falls back to a
 * slug plus a hash — with the real path in a `.cwd` file — when that name would
 * exceed 255 bytes (`17-sessions.md`, "Storage Layout"). purplemux never
 * reconstructs the name: it reads the group's own record, so a change to the
 * encoding cannot silently unbind a tab from its transcript.
 */
export const readGrokGroupCwd = async (groupDir: string): Promise<string | null> => {
  const marker = await fs.readFile(path.join(groupDir, GROK_CWD_MARKER_FILENAME), 'utf-8').catch(() => null);
  if (marker?.trim()) return marker.trim();
  try {
    return decodeURIComponent(path.basename(groupDir));
  } catch {
    return null;
  }
};

const listDirs = async (dir: string): Promise<string[]> => {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
};

const toRef = async (
  home: string,
  groupDir: string,
  groupCwd: string | null,
  sessionId: string,
): Promise<IGrokSessionRef | null> => {
  const sessionDir = path.join(groupDir, sessionId);
  const jsonlPath = path.join(sessionDir, GROK_UPDATES_FILENAME);
  let lastActivityMs: number;
  try {
    lastActivityMs = (await fs.stat(jsonlPath)).mtimeMs;
  } catch {
    return null;
  }
  // The group name is the cheap answer; `summary.json` is the authoritative one
  // and is only read when the group could not name its own directory.
  const cwd = groupCwd ?? (await readGrokSummary(sessionDir))?.cwd ?? null;
  return {
    sessionId,
    home,
    workspaceId: workspaceIdForGrokHome(home),
    sessionDir,
    jsonlPath,
    cwd,
    lastActivityMs,
  };
};

/** Every session under one grok home, newest first. */
export const listGrokSessionsInHome = async (home: string): Promise<IGrokSessionRef[]> => {
  const root = grokSessionsRoot(home);
  const groups = await listDirs(root);

  const perGroup = await Promise.all(groups.map(async (group) => {
    const groupDir = path.join(root, group);
    const groupCwd = await readGrokGroupCwd(groupDir);
    const sessionIds = (await listDirs(groupDir)).filter(isValidGrokSessionId);
    const refs = await Promise.all(sessionIds.map((id) => toRef(home, groupDir, groupCwd, id)));
    return refs.filter((ref): ref is IGrokSessionRef => ref !== null);
  }));

  return perGroup.flat().sort((a, b) => b.lastActivityMs - a.lastActivityMs);
};

/** Every session across the unscoped home and every workspace home, newest first. */
export const listAllGrokSessions = async (): Promise<IGrokSessionRef[]> => {
  const homes = await listGrokHomes();
  const perHome = await Promise.all(homes.map(listGrokSessionsInHome));
  return perHome.flat().sort((a, b) => b.lastActivityMs - a.lastActivityMs);
};

export const findGrokSessionById = async (sessionId: string): Promise<IGrokSessionRef | null> => {
  if (!isValidGrokSessionId(sessionId)) return null;
  for (const home of await listGrokHomes()) {
    const found = (await listGrokSessionsInHome(home)).find((ref) => ref.sessionId === sessionId);
    if (found) return found;
  }
  return null;
};

/** The newest session grok recorded for `cwd`, in `home` when one is named. */
export const findLatestGrokSessionForCwd = async (
  cwd: string,
  home?: string,
): Promise<IGrokSessionRef | null> => {
  const homes = home ? [home] : await listGrokHomes();
  const resolved = path.resolve(cwd);
  for (const candidate of homes) {
    const match = (await listGrokSessionsInHome(candidate))
      .find((ref) => ref.cwd !== null && path.resolve(ref.cwd) === resolved);
    if (match) return match;
  }
  return null;
};
