import type { ISessionInfo } from '@/types/timeline';
import type {
  IAgentSessionDetectionOptions,
  IAgentSessionWatchOptions,
  ISessionWatcher,
} from '@/lib/providers/types';
import { grokHookEvents } from '@/lib/providers/grok/hook-events';
import { runGrokPreflight } from '@/lib/providers/grok/preflight';
import { GROK_DB_PATH, getGrokDatabase, grokStoreExists } from '@/lib/providers/grok/db';
import {
  getChildPids,
  getProcessArgs,
  getProcessCwd,
  isProcessRunning,
} from '@/lib/process-utils';

const PID_POLL_INTERVAL = 10_000;

/** `createSessionId()` in grok's `src/storage/sessions.ts`: a uuid stripped of dashes, first 12 chars. */
const GROK_SESSION_ID_RE = /^[0-9a-f]{12}$/;
const GROK_SESSION_ARG_RE = /(?:^|\s)(?:--session|-s)(?:=|\s+)["']?([0-9a-f]{12}|latest)["']?(?=\s|$)/i;

export const isValidGrokSessionId = (id: unknown): id is string =>
  typeof id === 'string' && GROK_SESSION_ID_RE.test(id);

const NOT_RUNNING: ISessionInfo = {
  status: 'not-running',
  sessionId: null,
  jsonlPath: null,
  pid: null,
  startedAt: null,
  cwd: null,
};

const matchesGrokArgs = (args: string): boolean => /(^|\/|\s)grok(\s|$)/.test(args);

export const extractGrokSessionId = (args: string): string | null => {
  const match = args.match(GROK_SESSION_ARG_RE)?.[1];
  return match && match !== 'latest' ? match.toLowerCase() : null;
};

const collectDescendants = async (panePid: number, preloaded?: number[]): Promise<number[]> => {
  const direct = preloaded ?? await getChildPids(panePid);
  if (direct.length === 0) return [];
  const grand = (await Promise.all(direct.map(getChildPids))).flat();
  return [...direct, ...grand];
};

const findGrokProcess = async (
  pids: number[],
): Promise<{ pid: number; cwd: string | null; args: string } | null> => {
  for (const pid of pids) {
    const args = await getProcessArgs(pid);
    if (!args || !matchesGrokArgs(args)) continue;
    return { pid, cwd: await getProcessCwd(pid), args };
  }
  return null;
};

interface IGrokSessionMeta {
  sessionId: string;
  cwd: string | null;
  startedAt: number | null;
}

const SESSION_BY_CWD_SQL = `
  SELECT id, cwd_last, created_at
  FROM sessions
  WHERE cwd_last = ?
  ORDER BY updated_at DESC
  LIMIT 1
`;

const SESSION_BY_ID_SQL = `
  SELECT id, cwd_last, created_at
  FROM sessions
  WHERE id = ?
`;

interface ISessionRow {
  id: string;
  cwd_last: string | null;
  created_at: string;
}

const toMeta = (row: ISessionRow | null): IGrokSessionMeta | null => {
  if (!row) return null;
  const startedAt = Date.parse(row.created_at);
  return {
    sessionId: row.id,
    cwd: row.cwd_last,
    startedAt: Number.isNaN(startedAt) ? null : startedAt,
  };
};

/**
 * grok keys its own sessions by cwd (`workspaces`), so the newest session for
 * the tab's directory is the right fallback when the process carries no
 * `--session` flag.
 */
export const findLatestGrokSessionForCwd = (
  cwd: string,
  dbPath: string = GROK_DB_PATH,
): IGrokSessionMeta | null => {
  const db = getGrokDatabase(dbPath);
  return db ? toMeta(db.get<ISessionRow>(SESSION_BY_CWD_SQL, cwd)) : null;
};

export const findGrokSessionById = (
  sessionId: string,
  dbPath: string = GROK_DB_PATH,
): IGrokSessionMeta | null => {
  const db = getGrokDatabase(dbPath);
  return db ? toMeta(db.get<ISessionRow>(SESSION_BY_ID_SQL, sessionId)) : null;
};

const toRunningSessionInfo = (
  found: { pid: number; cwd: string | null },
  meta?: IGrokSessionMeta | null,
): ISessionInfo => ({
  status: 'running',
  sessionId: meta?.sessionId ?? null,
  jsonlPath: null,
  pid: found.pid,
  startedAt: meta?.startedAt ?? null,
  cwd: meta?.cwd ?? found.cwd,
});

export const isGrokRunning = async (
  panePid: number,
  preloadedChildPids?: number[],
): Promise<boolean> => {
  for (const pid of await collectDescendants(panePid, preloadedChildPids)) {
    const args = await getProcessArgs(pid);
    if (args && matchesGrokArgs(args)) return true;
  }
  return false;
};

export const detectActiveSession = async (
  panePid: number,
  preloadedChildPids?: number[],
  options: IAgentSessionDetectionOptions = {},
): Promise<ISessionInfo> => {
  if (!grokStoreExists()) {
    const { installed } = await runGrokPreflight();
    const status = installed ? 'not-initialized' : 'not-installed';
    return { status, sessionId: null, jsonlPath: null, pid: null, startedAt: null, cwd: null };
  }

  const all = await collectDescendants(panePid, preloadedChildPids);
  if (all.length === 0) return NOT_RUNNING;

  const found = await findGrokProcess(all);
  if (!found) return NOT_RUNNING;

  const resumeSessionId = extractGrokSessionId(found.args);
  if (resumeSessionId) {
    return toRunningSessionInfo(found, findGrokSessionById(resumeSessionId) ?? {
      sessionId: resumeSessionId,
      cwd: found.cwd,
      startedAt: null,
    });
  }

  if (options.allowCwdFallback && found.cwd) {
    const meta = findLatestGrokSessionForCwd(found.cwd);
    if (meta) return toRunningSessionInfo(found, meta);
  }

  return toRunningSessionInfo(found);
};

export const watchSessions = (
  panePid: number,
  onChange: (info: ISessionInfo) => void,
  options?: IAgentSessionWatchOptions,
): ISessionWatcher => {
  let stopped = false;
  let currentPid: number | null = null;
  let currentSessionId: string | null = null;
  const watchedSession = options?.tmuxSession;

  const rememberInfo = (info: ISessionInfo) => {
    if (info.pid) currentPid = info.pid;
    currentSessionId = info.sessionId;
  };

  const handleSessionInfo = (tmuxSession: string, info: ISessionInfo) => {
    if (stopped || !watchedSession || tmuxSession !== watchedSession) return;
    rememberInfo(info);
    onChange(info);
  };

  if (watchedSession) grokHookEvents.on('session-info', handleSessionInfo);

  const poll = async () => {
    if (stopped) return;
    if (!currentPid) {
      const info = await detectActiveSession(panePid, undefined, { allowCwdFallback: true });
      rememberInfo(info);
      if (info.sessionId) onChange(info);
      return;
    }
    if (!await isProcessRunning(currentPid)) {
      if (stopped) return;
      currentPid = null;
      const info = await detectActiveSession(panePid);
      rememberInfo(info);
      onChange(info);
      return;
    }
    if (!currentSessionId) {
      const info = await detectActiveSession(panePid, undefined, { allowCwdFallback: true });
      if (info.sessionId !== currentSessionId) {
        rememberInfo(info);
        onChange(info);
      }
    }
  };

  const pollTimer = setInterval(poll, PID_POLL_INTERVAL);

  if (!options?.skipInitial) {
    detectActiveSession(panePid, undefined, { allowCwdFallback: true }).then((info) => {
      if (stopped) return;
      rememberInfo(info);
      onChange(info);
    });
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(pollTimer);
      if (watchedSession) grokHookEvents.off('session-info', handleSessionInfo);
    },
  };
};
