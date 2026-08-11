import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import readline from 'readline';
import type { IProjectStats, ISessionStats, TPeriod } from '@/types/stats';
import { listClaudeProjectsDirs } from '@/lib/workspace-home';
import { isWithinPeriod } from './period-filter';
import { shortenCwd } from './daily-report-builder';

const CONCURRENCY_LIMIT = 10;

interface IRawSessionAgg {
  sessionId: string;
  project: string;
  startedAt: string;
  lastActivityAt: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  model: string;
}

const isAgentFile = (filename: string): boolean => /^agent-/.test(filename);

const collectJsonlFiles = async (): Promise<{ filePath: string; project: string }[]> => {
  const result: { filePath: string; project: string }[] = [];
  for (const projectsRoot of await listClaudeProjectsDirs()) {
    const projectDirs = await fs.readdir(projectsRoot).catch(() => [] as string[]);
    for (const dir of projectDirs) {
      const projectPath = path.join(projectsRoot, dir);
      const stat = await fs.stat(projectPath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const files = await fs.readdir(projectPath).catch(() => []);
      for (const file of files) {
        if (!file.endsWith('.jsonl') || isAgentFile(file)) continue;
        result.push({ filePath: path.join(projectPath, file), project: dir });
      }
    }
  }
  return result;
};

const parseJsonlStream = async (
  filePath: string,
  project: string,
  period: TPeriod,
): Promise<IRawSessionAgg[]> => {
  const sessions = new Map<string, IRawSessionAgg>();
  const countedUsageIds = new Set<string>();
  let cwd = '';

  try {
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const timestamp = String(entry.timestamp ?? '');

        if (!cwd && typeof entry.cwd === 'string') {
          cwd = entry.cwd;
        }

        if (!timestamp || !isWithinPeriod(timestamp, period)) continue;

        const sessionId = String(entry.sessionId ?? '');
        if (!sessionId) continue;

        const type = String(entry.type ?? '');
        if (type !== 'user' && type !== 'assistant') continue;

        let agg = sessions.get(sessionId);
        if (!agg) {
          agg = {
            sessionId,
            project,
            startedAt: timestamp,
            lastActivityAt: timestamp,
            messageCount: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheReadTokens: 0,
            totalCacheCreationTokens: 0,
            model: '',
          };
          sessions.set(sessionId, agg);
        }

        if (timestamp < agg.startedAt) agg.startedAt = timestamp;
        if (timestamp > agg.lastActivityAt) agg.lastActivityAt = timestamp;

        if (type === 'user') {
          agg.messageCount++;
        }

        if (type === 'assistant') {
          const message = entry.message as Record<string, unknown> | undefined;
          if (message) {
            const model = String(message.model ?? '');
            if (model) agg.model = model;

            const usage = message.usage as Record<string, unknown> | undefined;
            if (usage) {
              const messageId = typeof message.id === 'string' ? message.id : '';
              const usageId = messageId || String(entry.uuid ?? '');
              if (!usageId || !countedUsageIds.has(usageId)) {
                if (usageId) countedUsageIds.add(usageId);
                agg.totalInputTokens += Number(usage.input_tokens ?? 0);
                agg.totalOutputTokens += Number(usage.output_tokens ?? 0);
                agg.totalCacheReadTokens += Number(usage.cache_read_input_tokens ?? 0);
                agg.totalCacheCreationTokens += Number(usage.cache_creation_input_tokens ?? 0);
              }
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file read error
  }

  if (cwd) {
    const resolvedProject = shortenCwd(cwd);
    for (const agg of sessions.values()) {
      agg.project = resolvedProject;
    }
  }

  return Array.from(sessions.values());
};

const runWithConcurrency = async <T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> => {
  const results: T[] = [];
  let index = 0;

  const runNext = async (): Promise<void> => {
    while (index < tasks.length) {
      const current = index++;
      results[current] = await tasks[current]();
    }
  };

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
};

const parseJsonlTimestampsByDay = async (
  filePath: string,
  targetDates: Set<string>,
): Promise<Map<string, Map<string, number[]>>> => {
  const days = new Map<string, Map<string, number[]>>();

  try {
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const timestamp = String(entry.timestamp ?? '');
        if (!timestamp) continue;

        const date = timestamp.slice(0, 10);
        if (!targetDates.has(date)) continue;

        const sessionId = String(entry.sessionId ?? '');
        if (!sessionId) continue;

        const type = String(entry.type ?? '');
        if (type !== 'user' && type !== 'assistant') continue;

        const ts = new Date(timestamp).getTime();
        if (isNaN(ts)) continue;

        let daySessions = days.get(date);
        if (!daySessions) {
          daySessions = new Map();
          days.set(date, daySessions);
        }

        const existing = daySessions.get(sessionId);
        if (existing) {
          existing.push(ts);
        } else {
          daySessions.set(sessionId, [ts]);
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file read error
  }

  return days;
};

export const parseTimestampsByDay = async (
  targetDates: Set<string>,
): Promise<Map<string, Map<string, number[]>>> => {
  const files = await collectJsonlFiles();
  if (files.length === 0) return new Map();

  const tasks = files.map((f) => () => parseJsonlTimestampsByDay(f.filePath, targetDates));
  const allResults = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);

  const merged = new Map<string, Map<string, number[]>>();
  for (const result of allResults) {
    for (const [date, daySessions] of result) {
      let existing = merged.get(date);
      if (!existing) {
        existing = new Map();
        merged.set(date, existing);
      }
      for (const [sessionId, timestamps] of daySessions) {
        const existingTs = existing.get(sessionId);
        if (existingTs) {
          existingTs.push(...timestamps);
        } else {
          existing.set(sessionId, [...timestamps]);
        }
      }
    }
  }

  return merged;
};

export const parseAllProjects = async (period: TPeriod): Promise<IProjectStats[]> => {
  const files = await collectJsonlFiles();
  if (files.length === 0) return [];

  const tasks = files.map((f) => () => parseJsonlStream(f.filePath, f.project, period));
  const allResults = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);

  const projectMap = new Map<string, IProjectStats>();

  for (const sessions of allResults) {
    for (const s of sessions) {
      const existing = projectMap.get(s.project);
      if (existing) {
        existing.sessionCount++;
        existing.messageCount += s.messageCount;
        existing.totalTokens += s.totalInputTokens + s.totalOutputTokens;
      } else {
        projectMap.set(s.project, {
          project: s.project,
          sessionCount: 1,
          messageCount: s.messageCount,
          totalTokens: s.totalInputTokens + s.totalOutputTokens,
        });
      }
    }
  }

  return Array.from(projectMap.values()).sort((a, b) => b.totalTokens - a.totalTokens);
};

export const parseAllSessions = async (period: TPeriod): Promise<ISessionStats[]> => {
  const files = await collectJsonlFiles();
  if (files.length === 0) return [];

  const tasks = files.map((f) => () => parseJsonlStream(f.filePath, f.project, period));
  const allResults = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);

  const sessions: ISessionStats[] = [];

  for (const fileResults of allResults) {
    for (const s of fileResults) {
      sessions.push({
        sessionId: s.sessionId,
        project: s.project,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
        messageCount: s.messageCount,
        totalTokens: s.totalInputTokens + s.totalOutputTokens,
        totalTokensWithCached: s.totalInputTokens + s.totalOutputTokens + s.totalCacheReadTokens + s.totalCacheCreationTokens,
        model: s.model,
      });
    }
  }

  return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
};
