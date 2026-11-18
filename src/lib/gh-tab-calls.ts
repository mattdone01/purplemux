import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DAY_MS, GH_COMMAND_WORDS, GH_PLAIN_COMMANDS, kindOfWords, minuteOf, type IGhCallCount, type TGhKind } from '@/lib/github-usage-ledger';

// The tab calls the gh shim logged (engineering#810): one file per UTC day, `<epoch> <tab> <ws> <w1> <w2>` a line.

/** Where the shim writes, as the shim resolves it: `${XDG_STATE_HOME:-$HOME/.local/state}/purplemux/gh-calls`. */
export const ghCallsDir = (env: Readonly<Record<string, string | undefined>> = process.env, home: string = os.homedir()): string =>
  path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'purplemux', 'gh-calls');

const ID = /^(?:-|[A-Za-z0-9_-]+)$/;
const EPOCH = /^\d{1,12}$/;
const DAY_FILE = /^(\d{8})\.log$/;

const knownWords = (w1: string, w2: string): boolean => {
  if (w1 === 'api') return w2 === 'rest' || w2 === 'graphql';
  if (w1 === '?') return w2 === '?';
  if (Object.prototype.hasOwnProperty.call(GH_COMMAND_WORDS, w1)) return w2 === '-' || w2 === '?' || GH_COMMAND_WORDS[w1].includes(w2);
  return GH_PLAIN_COMMANDS.includes(w1) && (w2 === '-' || w2 === '?');
};

export interface IGhCallLine {
  at: number;
  tabId: string;
  workspaceId: string;
  w1: string;
  w2: string;
  kind: TGhKind;
}

/** One shim line, or null for any line that is not exactly the shim's grammar and vocabulary. */
export const parseGhCallLine = (line: string): IGhCallLine | null => {
  const parts = line.trim().split(' ');
  if (parts.length !== 5) return null;
  const [epoch, tabId, workspaceId, w1, w2] = parts;
  if (!EPOCH.test(epoch) || !ID.test(tabId) || !ID.test(workspaceId) || !knownWords(w1, w2)) return null;
  return { at: Number(epoch) * 1000, tabId, workspaceId, w1, w2, kind: kindOfWords(w1, w2) };
};

export interface ITabCallRead {
  counts: IGhCallCount[];
  /** Lines that did not parse: not counted, and said so. */
  skippedLines: number;
  /** Day files older than yesterday (UTC), removed by this read. */
  pruned: string[];
  /** The directory could not be read: the tab counts are missing, never zero. */
  error: string | null;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The last 24 hours of tab calls, from today's and yesterday's files, counted per minute; older files are removed. */
export const readTabGhCalls = async (dir: string, now: number): Promise<ITabCallRead> => {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { counts: [], skippedLines: 0, pruned: [], error: null };
    return { counts: [], skippedLines: 0, pruned: [], error: errorText(err) };
  }
  const keep = new Set([utcDay(now), utcDay(now - DAY_MS)]);
  const from = now - DAY_MS;
  const buckets = new Map<string, IGhCallCount>();
  const pruned: string[] = [];
  let skippedLines = 0;
  for (const name of names.sort()) {
    const day = DAY_FILE.exec(name)?.[1];
    if (!day) continue;
    if (!keep.has(day)) {
      if (day < utcDay(now - DAY_MS)) {
        await fs.rm(path.join(dir, name), { force: true });
        pruned.push(name);
      }
      continue;
    }
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, name), 'utf-8');
    } catch (err) {
      return { counts: [], skippedLines, pruned, error: `${name}: ${errorText(err)}` };
    }
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      const line = parseGhCallLine(raw);
      if (!line) {
        skippedLines++;
        continue;
      }
      if (line.at < from || line.at > now) continue;
      const at = minuteOf(line.at);
      const key = [at, line.workspaceId, line.tabId, line.w1, line.w2].join(' ');
      const bucket = buckets.get(key);
      if (bucket) bucket.count++;
      else buckets.set(key, { source: 'tab', workspaceId: line.workspaceId, tabId: line.tabId, kind: line.kind, w1: line.w1, w2: line.w2, at, count: 1 });
    }
  }
  return { counts: [...buckets.values()], skippedLines, pruned, error: null };
};
