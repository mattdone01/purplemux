import path from 'path';
import type { ISessionInfo } from '@/types/timeline';
import type {
  IAgentSessionDetectionOptions,
  IAgentSessionWatchOptions,
  ISessionWatcher,
} from '@/lib/providers/types';
import { workspaceGrokHomeDir } from '@/lib/grok-home';
import { workspaceIdFromSessionName } from '@/lib/workspace-home';
import { grokHookEvents } from '@/lib/providers/grok/hook-events';
import { runGrokPreflight } from '@/lib/providers/grok/preflight';
import {
  findGrokSessionById,
  findLatestGrokSessionForCwd,
  isValidGrokSessionId,
  type IGrokSessionRef,
} from '@/lib/providers/grok/session-store';
import {
  getChildPids,
  getProcessArgs,
  getProcessCwd,
  isProcessRunning,
} from '@/lib/process-utils';

const PID_POLL_INTERVAL = 10_000;

export { isValidGrokSessionId };

/**
 * `-s/--session-id` names a NEW session's id; `-r/--resume` resumes one.
 * `--resume` also accepts a title, so only a UUID-shaped value is taken as an
 * id (`17-sessions.md`, "Resuming Sessions").
 */
const SESSION_ARG_RE =
  /(?:^|\s)(?:--session-id|-s|--resume|-r)(?:=|\s+)["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']?(?=\s|$)/i;

const CWD_ARG_RE = /(?:^|\s)--cwd(?:=|\s+)["']?([^"'\s]+)["']?(?=\s|$)/;

const NOT_RUNNING: ISessionInfo = {
  status: 'not-running',
  sessionId: null,
  jsonlPath: null,
  pid: null,
  startedAt: null,
  cwd: null,
};

/** The binary is `grok`; the install also links it as `agent`. */
const matchesGrokArgs = (args: string): boolean => /(^|\/|\s)(grok|agent)(\s|$)/.test(args);

export const extractGrokSessionId = (args: string): string | null =>
  args.match(SESSION_ARG_RE)?.[1]?.toLowerCase() ?? null;

export const extractGrokCwd = (args: string): string | null => args.match(CWD_ARG_RE)?.[1] ?? null;

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
    return { pid, cwd: extractGrokCwd(args) ?? await getProcessCwd(pid), args };
  }
  return null;
};

const toSessionInfo = (
  found: { pid: number; cwd: string | null },
  ref: IGrokSessionRef | null,
): ISessionInfo => ({
  status: 'running',
  sessionId: ref?.sessionId ?? null,
  jsonlPath: ref?.jsonlPath ?? null,
  pid: found.pid,
  startedAt: null,
  cwd: ref?.cwd ?? found.cwd,
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

/**
 * The grok home a pane's agent runs under. `workspaceEnv` sets `GROK_HOME` to
 * exactly this path for a workspace pane (`tmux.ts`), so the tmux session name
 * resolves it without reading the process environment. An ad-hoc pane has no
 * workspace segment and runs against the unscoped `~/.grok`.
 */
const paneGrokHome = (tmuxSession: string | undefined): string | undefined => {
  const wsId = tmuxSession ? workspaceIdFromSessionName(tmuxSession) : null;
  return wsId ? workspaceGrokHomeDir(wsId) : undefined;
};

/**
 * Grok groups its sessions by working directory, so the newest session dir for
 * the pane's cwd is the right answer when the process carries no `--session-id`
 * or `--resume`. Cwd alone does NOT identify a session: the same project opened
 * in two workspaces has one session dir per home, and the unscoped `~/.grok` is
 * scanned first. The lookup is therefore pinned to the pane's own home, and
 * only an ad-hoc pane — which has none — falls back to scanning every home.
 */
export const detectActiveSession = async (
  panePid: number,
  preloadedChildPids?: number[],
  options: IAgentSessionDetectionOptions = {},
): Promise<ISessionInfo> => {
  const all = await collectDescendants(panePid, preloadedChildPids);
  if (all.length === 0) {
    const { installed } = await runGrokPreflight();
    return installed
      ? NOT_RUNNING
      : { status: 'not-installed', sessionId: null, jsonlPath: null, pid: null, startedAt: null, cwd: null };
  }

  const found = await findGrokProcess(all);
  if (!found) return NOT_RUNNING;

  const argSessionId = extractGrokSessionId(found.args);
  if (argSessionId) {
    const ref = await findGrokSessionById(argSessionId);
    return toSessionInfo(found, ref ?? {
      sessionId: argSessionId,
      home: '',
      workspaceId: null,
      sessionDir: '',
      jsonlPath: '',
      cwd: found.cwd,
      lastActivityMs: 0,
    });
  }

  if (options.allowCwdFallback && found.cwd) {
    const ref = await findLatestGrokSessionForCwd(found.cwd, paneGrokHome(options.tmuxSession));
    if (ref) return toSessionInfo(found, ref);
  }

  return toSessionInfo(found, null);
};

/**
 * Resolves the transcript for a session id the hook already told us about. The
 * hook fires before the first `updates.jsonl` write on a brand-new session, so
 * a miss here is expected and the poller picks it up.
 */
export const resolveGrokJsonlPath = async (sessionId: string): Promise<string | null> =>
  (await findGrokSessionById(sessionId))?.jsonlPath ?? null;

export const grokSessionDirFromJsonlPath = (jsonlPath: string): string => path.dirname(jsonlPath);

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

  // A hook lands before the transcript file exists, so the id it carries is
  // resolved to a path here rather than trusted to be complete.
  const handleSessionInfo = async (tmuxSession: string, info: ISessionInfo) => {
    if (stopped || !watchedSession || tmuxSession !== watchedSession) return;
    const jsonlPath = info.jsonlPath
      ?? (info.sessionId ? await resolveGrokJsonlPath(info.sessionId) : null);
    if (stopped) return;
    const resolved: ISessionInfo = { ...info, jsonlPath };
    rememberInfo(resolved);
    onChange(resolved);
  };

  if (watchedSession) grokHookEvents.on('session-info', handleSessionInfo);

  const poll = async () => {
    if (stopped) return;
    if (!currentPid) {
      const info = await detectActiveSession(panePid, undefined, {
        allowCwdFallback: true,
        tmuxSession: watchedSession,
      });
      rememberInfo(info);
      if (info.sessionId) onChange(info);
      return;
    }
    if (!await isProcessRunning(currentPid)) {
      if (stopped) return;
      currentPid = null;
      const info = await detectActiveSession(panePid, undefined, { tmuxSession: watchedSession });
      rememberInfo(info);
      onChange(info);
      return;
    }
    if (!currentSessionId) {
      const info = await detectActiveSession(panePid, undefined, {
        allowCwdFallback: true,
        tmuxSession: watchedSession,
      });
      if (info.sessionId !== currentSessionId) {
        rememberInfo(info);
        onChange(info);
      }
    }
  };

  const pollTimer = setInterval(poll, PID_POLL_INTERVAL);

  if (!options?.skipInitial) {
    detectActiveSession(panePid, undefined, {
      allowCwdFallback: true,
      tmuxSession: watchedSession,
    }).then((info) => {
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
