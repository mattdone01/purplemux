import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import readline from 'readline';
import { toClaudeProjectName } from '@/lib/providers/claude/session-detection';
import { claudeHomeForSession } from '@/lib/workspace-home';
import { getSessionCwd } from '@/lib/tmux';
import { createLogger } from '@/lib/logger';
import { createMetaCache } from '@/lib/session-meta-cache';
import type { ISessionMeta } from '@/types/timeline';

const log = createLogger('session-list');

const GLOBAL_PROJECTS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '/',
  '.claude',
  'projects',
);
const MAX_CONCURRENCY = 10;
const MAX_FIRST_MESSAGE_LENGTH = 200;

const metaCache = createMetaCache();

// A workspace-shaped tmux session runs claude with the workspace's own
// CLAUDE_CONFIG_DIR (src/lib/tmux.ts), so its transcripts live in that
// claude-home — resolving against ~/.claude there would list sessions the
// scoped claude cannot see, let alone resume. Sessions without a workspace
// resolve to the global store, as before.
export const cwdToProjectPath = (cwd: string, tmuxSession?: string): string => {
  const home = tmuxSession ? claudeHomeForSession(tmuxSession) : null;
  const projectsDir = home ? path.join(home, 'projects') : GLOBAL_PROJECTS_DIR;
  return path.join(projectsDir, toClaudeProjectName(cwd));
};

const runWithConcurrency = async <T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> => {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  const runNext = async (): Promise<void> => {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      try {
        const value = await tasks[idx]();
        results[idx] = { status: 'fulfilled', value };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
};

const truncateMessage = (text: string): string =>
  text.length <= MAX_FIRST_MESSAGE_LENGTH
    ? text
    : text.slice(0, MAX_FIRST_MESSAGE_LENGTH) + '…';

interface IJsonlScanResult {
  startedAt: string | null;
  firstMessage: string;
  turnCount: number;
}

const scanJsonl = async (filePath: string): Promise<IJsonlScanResult> => {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let startedAt: string | null = null;
  let firstMessage = '';
  let turnCount = 0;
  let isFirstLine = true;

  try {
    for await (const line of rl) {
      if (isFirstLine) {
        isFirstLine = false;
        if (line.trim()) {
          try {
            const entry = JSON.parse(line);
            if (entry.timestamp) {
              startedAt = new Date(entry.timestamp).toISOString();
            }
          } catch {}
        }
      }

      const isHumanOrUser =
        line.includes('"type":"human"') ||
        line.includes('"type": "human"') ||
        line.includes('"type":"user"') ||
        line.includes('"type": "user"');
      if (isHumanOrUser && !line.includes('"isMeta":true') && !line.includes('"isMeta": true')) {
        turnCount++;

        if (!firstMessage) {
          try {
            const entry = JSON.parse(line);
            if ((entry.type === 'human' || entry.type === 'user') && !entry.isMeta) {
              const msg = entry.message;
              if (msg) {
                if (typeof msg === 'string') {
                  firstMessage = truncateMessage(msg);
                } else if (Array.isArray(msg.content)) {
                  const textBlock = msg.content.find(
                    (b: { type: string; text?: string }) => b.type === 'text' && b.text,
                  );
                  if (textBlock) firstMessage = truncateMessage(textBlock.text);
                } else if (typeof msg.content === 'string') {
                  firstMessage = truncateMessage(msg.content);
                }
              }
            }
          } catch {}
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { startedAt, firstMessage, turnCount };
};

export const parseSessionMeta = async (jsonlPath: string): Promise<ISessionMeta | null> => {
  try {
    const stat = await fs.stat(jsonlPath);
    const sessionId = path.basename(jsonlPath, '.jsonl');

    const cached = metaCache.get('claude', sessionId);
    if (cached && !metaCache.isStale('claude', sessionId, stat.mtimeMs)) {
      return cached;
    }

    const { startedAt: startedAtFromFile, firstMessage, turnCount } = await scanJsonl(jsonlPath);

    const startedAt = startedAtFromFile || stat.birthtime.toISOString();
    const lastActivityAt = stat.mtime.toISOString();

    const meta: ISessionMeta = {
      sessionId,
      startedAt,
      lastActivityAt,
      firstMessage,
      turnCount,
    };

    metaCache.set('claude', sessionId, meta, stat.mtimeMs);
    return meta;
  } catch (err) {
    log.warn({ err }, `failed to parse session meta: ${jsonlPath}`);
    return null;
  }
};

export const listSessions = async (tmuxSession: string, cwdHint?: string): Promise<ISessionMeta[]> => {
  const cwd = cwdHint || await getSessionCwd(tmuxSession);
  if (!cwd) throw new Error('cwd-lookup-failed');

  const projectDir = cwdToProjectPath(cwd, tmuxSession);

  let files: string[];
  try {
    const entries = await fs.readdir(projectDir);
    files = entries.filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const tasks = files.map((file) => () => parseSessionMeta(path.join(projectDir, file)));
  const results = await runWithConcurrency(tasks, MAX_CONCURRENCY);

  const sessions: ISessionMeta[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      sessions.push(result.value);
    }
  }

  sessions.sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );

  return sessions;
};
