import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { isSubagentSessionMeta, readTranscriptFirstLine } from '@/lib/providers/codex/session-meta-line';
import type { ISessionInfo } from '@/types/timeline';
import type { IAgentSessionDetectionOptions, IAgentSessionWatchOptions, ISessionWatcher } from '@/lib/providers/types';
import { codexHookEvents } from '@/lib/providers/codex/hook-events';
import { runCodexPreflight } from '@/lib/providers/codex/preflight';
import {
  getChildPids,
  getProcessArgs,
  getProcessCwd,
  getProcessStartTimeMs,
  isProcessRunning,
} from '@/lib/process-utils';

const CODEX_DIR = path.join(os.homedir(), '.codex');
const SESSIONS_ROOT = path.join(CODEX_DIR, 'sessions');
const PID_POLL_INTERVAL = 10_000;
const SESSION_SCAN_DAYS = 30;
const SESSION_PROCESS_GRACE_MS = 60_000;
const CODEX_SESSION_ID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CODEX_RESUME_ARG_RE = new RegExp(
  `(?:^|\\s)(?:resume|--resume-session-id)(?:=|\\s+)["']?(${CODEX_SESSION_ID_RE})["']?(?=\\s|$)`,
  'i',
);

const NOT_RUNNING: ISessionInfo = {
  status: 'not-running',
  sessionId: null,
  jsonlPath: null,
  pid: null,
  startedAt: null,
  cwd: null,
};

const matchesCodexArgs = (args: string): boolean => args.includes('codex');

interface ICodexSessionMeta {
  sessionId: string;
  jsonlPath: string;
  /** A native subagent's rollout (its session_meta says so): never a tab's own session. */
  subagent?: boolean;
  cwd: string | null;
  startedAt: number | null;
  mtimeMs: number | null;
}

type TCodexDetectedSessionMeta = Omit<ICodexSessionMeta, 'jsonlPath'> & {
  jsonlPath: string | null;
};

interface IFindLatestCodexSessionOptions {
  sessionsRoot?: string;
  daysBack?: number;
  now?: Date;
}

const dayDirPath = (sessionsRoot: string, date: Date): string =>
  path.join(
    sessionsRoot,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );

const readCodexSessionMeta = async (jsonlPath: string): Promise<ICodexSessionMeta | null> => {
  const firstLine = await readTranscriptFirstLine(jsonlPath);
  if (!firstLine) return null;

  try {
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      timestamp?: string;
      payload?: {
        id?: string;
        cwd?: string;
        timestamp?: string;
      };
    };
    if (parsed.type !== 'session_meta' || !parsed.payload?.id) return null;

    const startedRaw = parsed.payload.timestamp ?? parsed.timestamp;
    const startedAt = startedRaw ? new Date(startedRaw).getTime() : null;
    return {
      sessionId: parsed.payload.id,
      jsonlPath,
      subagent: isSubagentSessionMeta(firstLine),
      cwd: parsed.payload.cwd ?? null,
      startedAt: startedAt !== null && Number.isFinite(startedAt) ? startedAt : null,
      mtimeMs: null,
    };
  } catch {
    return null;
  }
};

const withJsonlMtime = async (meta: ICodexSessionMeta): Promise<ICodexSessionMeta> => {
  try {
    const stat = await fs.stat(meta.jsonlPath);
    return { ...meta, mtimeMs: stat.mtimeMs };
  } catch {
    return meta;
  }
};

export const findLatestCodexSessionForCwd = async (
  cwd: string,
  {
    sessionsRoot = SESSIONS_ROOT,
    daysBack = SESSION_SCAN_DAYS,
    now = new Date(),
  }: IFindLatestCodexSessionOptions = {},
): Promise<ICodexSessionMeta | null> => {
  const candidates: { jsonlPath: string; mtimeMs: number }[] = [];

  for (let i = 0; i < daysBack; i++) {
    const date = new Date(now);
    date.setDate(now.getDate() - i);
    const dir = dayDirPath(sessionsRoot, date);

    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }

    await Promise.all(names.filter((name) => name.endsWith('.jsonl')).map(async (name) => {
      const jsonlPath = path.join(dir, name);
      try {
        const stat = await fs.stat(jsonlPath);
        candidates.push({ jsonlPath, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore files that disappeared while scanning.
      }
    }));
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    const meta = await readCodexSessionMeta(candidate.jsonlPath);
    // A native subagent shares its root's cwd and writes more recently: never the tab's session.
    if (meta?.cwd === cwd && !meta.subagent) return { ...meta, mtimeMs: candidate.mtimeMs };
  }

  return null;
};

export const findCodexSessionById = async (
  sessionId: string,
  {
    sessionsRoot = SESSIONS_ROOT,
    daysBack = SESSION_SCAN_DAYS,
    now = new Date(),
  }: IFindLatestCodexSessionOptions = {},
): Promise<ICodexSessionMeta | null> => {
  for (let i = 0; i < daysBack; i++) {
    const date = new Date(now);
    date.setDate(now.getDate() - i);
    const dir = dayDirPath(sessionsRoot, date);

    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }

    const matchingNames = names.filter((name) => name.endsWith('.jsonl') && name.includes(sessionId));
    for (const name of matchingNames) {
      const meta = await readCodexSessionMeta(path.join(dir, name));
      if (meta?.sessionId === sessionId) return withJsonlMtime(meta);
    }
  }

  return null;
};

const collectDescendants = async (
  panePid: number,
  preloaded?: number[],
): Promise<number[]> => {
  const direct = preloaded ?? await getChildPids(panePid);
  if (direct.length === 0) return [];
  const grand = (await Promise.all(direct.map(getChildPids))).flat();
  return [...direct, ...grand];
};

const findCodexProcess = async (
  pids: number[],
): Promise<{ pid: number; cwd: string | null; args: string } | null> => {
  for (const pid of pids) {
    const args = await getProcessArgs(pid);
    if (!args || !matchesCodexArgs(args)) continue;
    const cwd = await getProcessCwd(pid);
    return { pid, cwd, args };
  }
  return null;
};

const extractResumeSessionId = (args: string): string | null =>
  args.match(CODEX_RESUME_ARG_RE)?.[1] ?? null;

const isLikelySessionForProcess = async (
  pid: number,
  meta: ICodexSessionMeta,
): Promise<boolean> => {
  if (meta.startedAt === null) return false;
  const processStartedAt = await getProcessStartTimeMs(pid, { timeoutMs: 1_000 });
  if (!processStartedAt) return true;

  const earliestSessionTime = processStartedAt - SESSION_PROCESS_GRACE_MS;
  return meta.startedAt >= earliestSessionTime;
};

const toRunningSessionInfo = (
  found: { pid: number; cwd: string | null },
  meta?: TCodexDetectedSessionMeta | null,
): ISessionInfo => ({
  status: 'running',
  sessionId: meta?.sessionId ?? null,
  jsonlPath: meta?.jsonlPath ?? null,
  pid: found.pid,
  startedAt: meta?.startedAt ?? null,
  cwd: meta?.cwd ?? found.cwd,
});

export const isCodexRunning = async (
  panePid: number,
  preloadedChildPids?: number[],
): Promise<boolean> => {
  const all = await collectDescendants(panePid, preloadedChildPids);
  for (const pid of all) {
    const args = await getProcessArgs(pid);
    if (args && matchesCodexArgs(args)) return true;
  }
  return false;
};

export const detectActiveSession = async (
  panePid: number,
  preloadedChildPids?: number[],
  options: IAgentSessionDetectionOptions = {},
): Promise<ISessionInfo> => {
  try {
    await fs.access(CODEX_DIR);
  } catch {
    const { installed } = await runCodexPreflight();
    const status = installed ? 'not-initialized' : 'not-installed';
    return { status, sessionId: null, jsonlPath: null, pid: null, startedAt: null, cwd: null };
  }

  const all = await collectDescendants(panePid, preloadedChildPids);
  if (all.length === 0) return NOT_RUNNING;

  const found = await findCodexProcess(all);
  if (!found) return NOT_RUNNING;

  const resumeSessionId = extractResumeSessionId(found.args);
  if (resumeSessionId) {
    const meta = await findCodexSessionById(resumeSessionId);
    return toRunningSessionInfo(
      found,
      meta ?? {
        sessionId: resumeSessionId,
        jsonlPath: null,
        cwd: found.cwd,
        startedAt: null,
        mtimeMs: null,
      },
    );
  }

  if (options.allowCwdFallback && found.cwd) {
    const meta = await findLatestCodexSessionForCwd(found.cwd);
    if (meta && await isLikelySessionForProcess(found.pid, meta)) {
      return toRunningSessionInfo(found, meta);
    }
  }

  return toRunningSessionInfo(found);
};

export const watchSessionsDir = (
  panePid: number,
  onChange: (info: ISessionInfo) => void,
  options?: IAgentSessionWatchOptions,
): ISessionWatcher => {
  let stopped = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let currentPid: number | null = null;
  let currentSessionId: string | null = null;
  let currentJsonlPath: string | null = null;
  const watchedSession = options?.tmuxSession;

  const rememberInfo = (info: ISessionInfo) => {
    if (info.pid) currentPid = info.pid;
    currentSessionId = info.sessionId;
    currentJsonlPath = info.jsonlPath;
  };

  const hasNewSessionInfo = (info: ISessionInfo): boolean =>
    info.sessionId !== currentSessionId || info.jsonlPath !== currentJsonlPath;

  const handleSessionInfo = (tmuxSession: string, info: ISessionInfo) => {
    if (stopped || !watchedSession || tmuxSession !== watchedSession) return;
    rememberInfo(info);
    onChange(info);
  };

  if (watchedSession) {
    codexHookEvents.on('session-info', handleSessionInfo);
  }

  const poll = async () => {
    if (stopped) return;
    if (!currentPid) {
      const info = await detectActiveSession(panePid);
      rememberInfo(info);
      if (info.sessionId || info.jsonlPath) onChange(info);
      return;
    }
    const alive = await isProcessRunning(currentPid);
    if (!alive && !stopped) {
      currentPid = null;
      const info = await detectActiveSession(panePid);
      rememberInfo(info);
      onChange(info);
      return;
    }

    if (!currentSessionId && !currentJsonlPath) {
      const info = await detectActiveSession(panePid);
      if (hasNewSessionInfo(info)) {
        rememberInfo(info);
        onChange(info);
      }
    }
  };

  pollTimer = setInterval(poll, PID_POLL_INTERVAL);

  if (!options?.skipInitial) {
    detectActiveSession(panePid).then((info) => {
      if (stopped) return;
      rememberInfo(info);
      onChange(info);
    });
  }

  return {
    stop: () => {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      if (watchedSession) {
        codexHookEvents.off('session-info', handleSessionInfo);
      }
    },
  };
};
