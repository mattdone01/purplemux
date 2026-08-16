import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { isAllowedJsonlPath } from '@/lib/path-validation';
import { findCodexSessionById } from '@/lib/providers/codex/session-detection';
import { findGrokSessionById } from '@/lib/providers/grok/session-store';
import { parseSessionKey } from '@/lib/session-key';
import { workspaceHomeDir } from '@/lib/workspace-home';

export const SESSION_PROVIDERS = ['claude', 'codex', 'grok'] as const;
export type TSessionProvider = (typeof SESSION_PROVIDERS)[number];

export type TSessionResolveError = 'bad-session-key' | 'session-not-found' | 'forbidden-path';

export interface IResolvedSession {
  sessionKey: string;
  provider: TSessionProvider;
  workspaceId: string | null;
  sessionId: string;
  jsonlPath: string;
}

export type TSessionResolution =
  | { ok: true; session: IResolvedSession }
  | { ok: false; error: TSessionResolveError };

// A key segment names one path component and nothing else: a separator, a
// traversal, or a null byte in a sessionId must never reach a readdir.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const isSafeSegment = (value: string): boolean =>
  value !== '.' && value !== '..' && SAFE_SEGMENT.test(value);

const isSupportedProvider = (provider: string): provider is TSessionProvider =>
  (SESSION_PROVIDERS as readonly string[]).includes(provider);

export const claudeProjectsRoot = (workspaceId: string | null): string =>
  workspaceId
    ? path.join(workspaceHomeDir(workspaceId), 'projects')
    : path.join(os.homedir(), '.claude', 'projects');

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

/**
 * Claude keys its store by encoded cwd, so the transcript for a session id sits
 * under one of the project dirs of the owning claude-home — which home is fixed
 * by the workspace scope, but which project dir is not.
 */
export const listClaudeTranscripts = async (
  workspaceId: string | null,
): Promise<{ sessionId: string; jsonlPath: string }[]> => {
  const root = claudeProjectsRoot(workspaceId);
  let projectDirs: string[];
  try {
    const dirents = await fs.readdir(root, { withFileTypes: true });
    projectDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }

  const perDir = await Promise.all(
    projectDirs.map(async (dirName) => {
      const dir = path.join(root, dirName);
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        return [];
      }
      return names
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => ({ sessionId: name.slice(0, -'.jsonl'.length), jsonlPath: path.join(dir, name) }));
    }),
  );

  return perDir.flat();
};

const findClaudeTranscript = async (
  workspaceId: string | null,
  sessionId: string,
): Promise<string | null> => {
  const root = claudeProjectsRoot(workspaceId);
  let projectDirs: string[];
  try {
    const dirents = await fs.readdir(root, { withFileTypes: true });
    projectDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }

  for (const dirName of projectDirs) {
    const candidate = path.join(root, dirName, `${sessionId}.jsonl`);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
};

/**
 * Turns `<provider>:<global|wsId>:<sessionId>` into a transcript path. Clients
 * address sessions by key only — no filesystem path crosses the wire — so this
 * is the single place a key becomes a path, and every result is checked against
 * `isAllowedJsonlPath` before it is handed back.
 */
export const resolveSessionKey = async (sessionKey: string): Promise<TSessionResolution> => {
  const parts = parseSessionKey(sessionKey);
  if (!parts) return { ok: false, error: 'bad-session-key' };

  const { provider, workspaceId, sessionId } = parts;
  if (!isSupportedProvider(provider)) return { ok: false, error: 'bad-session-key' };
  if (!isSafeSegment(sessionId)) return { ok: false, error: 'bad-session-key' };
  if (workspaceId !== null && !isSafeSegment(workspaceId)) return { ok: false, error: 'bad-session-key' };

  // Codex and grok both key by their own store rather than by the scope
  // segment, so the segment is validated above and then ignored — the same
  // "advisory scope" the API contract documents.
  let jsonlPath: string | null;
  if (provider === 'codex') {
    jsonlPath = (await findCodexSessionById(sessionId))?.jsonlPath ?? null;
  } else if (provider === 'grok') {
    jsonlPath = (await findGrokSessionById(sessionId))?.jsonlPath ?? null;
  } else {
    jsonlPath = await findClaudeTranscript(workspaceId, sessionId);
  }

  if (!jsonlPath) return { ok: false, error: 'session-not-found' };
  if (!isAllowedJsonlPath(jsonlPath)) return { ok: false, error: 'forbidden-path' };

  return { ok: true, session: { sessionKey, provider, workspaceId, sessionId, jsonlPath } };
};
