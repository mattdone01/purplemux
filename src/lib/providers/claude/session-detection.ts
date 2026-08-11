import fs from 'fs/promises';
import { watch, type FSWatcher } from 'fs';
import path from 'path';
import os from 'os';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type { ISessionInfo } from '@/types/timeline';
import type { ISessionWatcher } from '@/lib/providers/types';
import { getShellPath } from '@/lib/preflight';
import { listWorkspaceClaudeHomes } from '@/lib/workspace-home';
import {
  getChildPids,
  getProcessArgs,
  getProcessCwd,
  isProcessRunning,
} from '@/lib/process-utils';

const execFile = promisify(execFileCb);

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_KNOWN_PATHS = [path.join(os.homedir(), '.local', 'bin', 'claude')];
const PID_POLL_INTERVAL = 10_000;
const SESSION_DIR_DEBOUNCE = 200;
const WATCH_SYNC_INTERVAL = 60_000;

// A pane launched with a workspace CLAUDE_CONFIG_DIR (src/lib/tmux.ts) writes
// its session pid file and transcripts into that workspace's claude-home; a
// pane launched unscoped writes into ~/.claude. Session pid files name their
// process, so scanning every home and matching on pid cannot attribute a
// session to the wrong pane.
const candidateClaudeHomes = async (): Promise<string[]> => [
  CLAUDE_DIR,
  ...(await listWorkspaceClaudeHomes()),
];

interface IPidFileData {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

const MAX_SANITIZED_LENGTH = 200;

const simpleHash = (str: string): string => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
};

export const toClaudeProjectName = (dirPath: string): string => {
  const sanitized = dirPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized;
  }
  const hash = simpleHash(dirPath);
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`;
};

const getClaudeSessionFromArgs = async (
  childPids: number[],
): Promise<{ pid: number; sessionId: string; cwd: string | null } | null> => {
  for (const pid of childPids) {
    const args = await getProcessArgs(pid);
    if (!args) continue;
    const match = args.match(/claude\s+--resume\s+([0-9a-f-]{36})/);
    if (match) {
      const cwd = await getProcessCwd(pid);
      return { pid, sessionId: match[1], cwd };
    }
  }
  return null;
};

const readPidFile = async (filePath: string): Promise<IPidFileData | null> => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.pid || !data.sessionId) return null;
    return data as IPidFileData;
  } catch {
    return null;
  }
};

const findJsonlPath = async (projectDir: string, sessionId: string): Promise<string | null> => {
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  try {
    await fs.access(jsonlPath);
    return jsonlPath;
  } catch {
    return null;
  }
};

const isClaudeInstalled = async (): Promise<boolean> => {
  try {
    await execFile('claude', ['--version'], { timeout: 5000, env: { ...process.env, PATH: await getShellPath() } });
    return true;
  } catch {
    for (const p of CLAUDE_KNOWN_PATHS) {
      try {
        await fs.access(p);
        return true;
      } catch {
        // not found
      }
    }
    return false;
  }
};

export const isClaudeRunning = async (panePid: number, preloadedChildPids?: number[]): Promise<boolean> => {
  const childPids = preloadedChildPids ?? await getChildPids(panePid);
  for (const pid of childPids) {
    const args = await getProcessArgs(pid);
    if (args?.includes('claude')) return true;
  }
  return false;
};

const findSessionInHome = async (
  home: string,
  childPidSet: Set<number>,
): Promise<ISessionInfo | null> => {
  const sessionsDir = path.join(home, 'sessions');
  const projectsDir = path.join(home, 'projects');

  let pidFiles: string[];
  try {
    pidFiles = await fs.readdir(sessionsDir);
  } catch {
    return null;
  }

  for (const file of pidFiles.filter((f) => f.endsWith('.json'))) {
    const data = await readPidFile(path.join(sessionsDir, file));
    if (!data) continue;
    if (!childPidSet.has(data.pid)) continue;

    const processArgs = await getProcessArgs(data.pid);
    if (processArgs === null || !processArgs.includes('claude')) {
      try { await fs.unlink(path.join(sessionsDir, file)); } catch {}
      continue;
    }

    const projectDir = path.join(projectsDir, toClaudeProjectName(data.cwd));
    let jsonlPath = await findJsonlPath(projectDir, data.sessionId);
    let effectiveSessionId = data.sessionId;

    if (!jsonlPath) {
      const resumeMatch = processArgs.match(/--resume\s+([0-9a-f-]{36})/);
      if (resumeMatch) {
        const resumeJsonlPath = await findJsonlPath(projectDir, resumeMatch[1]);
        if (resumeJsonlPath) {
          jsonlPath = resumeJsonlPath;
          effectiveSessionId = resumeMatch[1];
        }
      }
    }

    return {
      status: 'running',
      sessionId: effectiveSessionId,
      jsonlPath,
      pid: data.pid,
      startedAt: data.startedAt,
      cwd: data.cwd,
    };
  }

  return null;
};

export const detectActiveSession = async (panePid: number, preloadedChildPids?: number[]): Promise<ISessionInfo> => {
  try {
    await fs.access(CLAUDE_DIR);
  } catch {
    const installed = await isClaudeInstalled();
    const status = installed ? 'not-initialized' : 'not-installed';
    return { status, sessionId: null, jsonlPath: null, pid: null, startedAt: null, cwd: null };
  }

  const directChildPids = preloadedChildPids ?? await getChildPids(panePid);

  if (directChildPids.length === 0) {
    return { status: 'not-running', sessionId: null, jsonlPath: null, pid: null, startedAt: null, cwd: null };
  }

  // Claude CLI may spawn a child process (e.g. for --resume), so the session
  // PID file can belong to a grandchild of the pane. Include one extra level.
  const grandchildPids = (await Promise.all(directChildPids.map(getChildPids))).flat();
  const allPids = [...directChildPids, ...grandchildPids];
  const childPidSet = new Set(allPids);

  const homes = await candidateClaudeHomes();
  for (const home of homes) {
    const info = await findSessionInHome(home, childPidSet);
    if (info) return info;
  }

  const fromArgs = await getClaudeSessionFromArgs(allPids);
  if (fromArgs?.cwd) {
    const projectName = toClaudeProjectName(fromArgs.cwd);
    let jsonlPath: string | null = null;
    for (const home of homes) {
      jsonlPath = await findJsonlPath(path.join(home, 'projects', projectName), fromArgs.sessionId);
      if (jsonlPath) break;
    }
    return {
      status: 'running',
      sessionId: fromArgs.sessionId,
      jsonlPath,
      pid: fromArgs.pid,
      startedAt: null,
      cwd: fromArgs.cwd,
    };
  }

  return { status: 'not-running', sessionId: null, jsonlPath: null, pid: null, startedAt: null, cwd: null };
};

export const watchSessionsDir = (
  panePid: number,
  onChange: (info: ISessionInfo) => void,
  options?: { skipInitial?: boolean },
): ISessionWatcher => {
  const watchers = new Map<string, FSWatcher>();
  let pidPollTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let currentPid: number | null = null;
  let stopped = false;

  const pollPid = async () => {
    if (stopped || !currentPid) return;
    const running = await isProcessRunning(currentPid);
    if (!running && !stopped) {
      currentPid = null;
      const info = await detectActiveSession(panePid);
      onChange(info);
    }
  };

  const handleSessionDirChange = () => {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (stopped) return;
      const info = await detectActiveSession(panePid);
      if (info.pid) currentPid = info.pid;
      onChange(info);
    }, SESSION_DIR_DEBOUNCE);
  };

  const dirExists = (dir: string) => fs.access(dir).then(() => true).catch(() => false);

  // Sessions dirs can appear after the watch starts (the first claude run
  // creates ~/.claude/sessions, a repointed workspace recreates its
  // claude-home), so watches are reconciled periodically instead of being
  // established once. A dir that gains its watch late may already contain the
  // session file, hence the re-detect after adding.
  const syncWatchers = async (initial = false) => {
    if (stopped) return;
    const dirs = (await candidateClaudeHomes()).map((home) => path.join(home, 'sessions'));
    const wanted = new Set(dirs);

    for (const [dir, watcher] of watchers) {
      if (wanted.has(dir) && await dirExists(dir)) continue;
      watcher.close();
      watchers.delete(dir);
    }

    if (stopped) return;
    let added = false;
    for (const dir of dirs) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, handleSessionDirChange);
        watcher.on('error', () => {});
        watchers.set(dir, watcher);
        added = true;
      } catch {
        // dir does not exist yet; the next sync retries
      }
    }

    if (added && !initial) handleSessionDirChange();
  };

  void syncWatchers(true);
  syncTimer = setInterval(() => void syncWatchers(), WATCH_SYNC_INTERVAL);
  pidPollTimer = setInterval(pollPid, PID_POLL_INTERVAL);

  if (!options?.skipInitial) {
    detectActiveSession(panePid).then((info) => {
      if (stopped) return;
      if (info.pid) currentPid = info.pid;
      onChange(info);
    });
  }

  return {
    stop: () => {
      stopped = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      if (pidPollTimer) clearInterval(pidPollTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (syncTimer) clearInterval(syncTimer);
    },
  };
};
