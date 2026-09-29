import { createReadStream } from 'fs';
import readline from 'readline';

/**
 * A Codex rollout's first line is its `session_meta` record. It carries the base instructions,
 * so it is large (20-30 KB measured on 2026-09-29) and read whole, with no byte cap: a cap would
 * silently stop recognising a session whose instructions grew.
 */
export const readTranscriptFirstLine = async (jsonlPath: string): Promise<string | null> => {
  const stream = createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      return line;
    }
    return null;
  } catch {
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
};

/**
 * True when a rollout's first line marks a native subagent session (a `spawn_agent` thread):
 * `source.subagent` or `thread_source: "subagent"`. A root session says `source: "cli"` and
 * `thread_source: "user"`.
 */
export const isSubagentSessionMeta = (line: string): boolean => {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return false;
  }
  if (!record || typeof record !== 'object') return false;
  const { type, payload } = record as { type?: unknown; payload?: unknown };
  if (type !== 'session_meta' || !payload || typeof payload !== 'object') return false;
  const meta = payload as { source?: unknown; thread_source?: unknown };
  if (meta.thread_source === 'subagent') return true;
  return !!meta.source && typeof meta.source === 'object' && 'subagent' in (meta.source as object);
};
