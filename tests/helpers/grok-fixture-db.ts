import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'grok-schema.sql',
);

export interface IGrokFixtureMessage {
  seq: number;
  role: string;
  message: unknown;
  createdAt?: string;
}

export interface IGrokFixtureToolCall {
  messageSeq: number;
  toolCallId: string;
  toolName: string;
  args?: unknown;
  output?: unknown;
  success?: boolean;
}

export interface IGrokFixtureUsage {
  messageSeq: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros?: number;
  createdAt?: string;
}

export interface IGrokFixtureCompaction {
  firstKeptSeq: number;
  summary: string;
  tokensBefore?: number;
  createdAt?: string;
}

export interface IGrokFixtureSession {
  id: string;
  workspaceId?: string;
  cwd?: string;
  model?: string;
  title?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messages?: IGrokFixtureMessage[];
  toolCalls?: IGrokFixtureToolCall[];
  usage?: IGrokFixtureUsage[];
  compactions?: IGrokFixtureCompaction[];
}

const TS0 = '2026-08-16T00:00:00.000Z';

/** Builds a throwaway `grok.db` from the captured grok-cli 1.1.7 schema. */
export const createGrokFixtureDb = (sessions: IGrokFixtureSession[]): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-grok-'));
  const dbPath = path.join(dir, 'grok.db');
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf-8'));

  const workspaces = new Set<string>();
  for (const session of sessions) {
    const workspaceId = session.workspaceId ?? 'ws0';
    const cwd = session.cwd ?? '/home/dev/project';
    if (!workspaces.has(workspaceId)) {
      workspaces.add(workspaceId);
      db.prepare(
        `INSERT INTO workspaces (id, scope_key, canonical_path, git_root, display_name, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(workspaceId, `scope-${workspaceId}`, cwd, cwd, path.basename(cwd), TS0);
    }

    db.prepare(
      `INSERT INTO sessions (id, workspace_id, title, recap_text, recap_model, recap_updated_at,
         model, mode, cwd_at_start, cwd_last, status, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, 'default', ?, ?, 'active', ?, ?)`,
    ).run(
      session.id,
      workspaceId,
      session.title ?? null,
      session.model ?? 'grok-4.20',
      cwd,
      cwd,
      session.createdAt ?? TS0,
      session.updatedAt ?? TS0,
    );

    for (const message of session.messages ?? []) {
      db.prepare(
        'INSERT INTO messages (session_id, seq, role, message_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(session.id, message.seq, message.role, JSON.stringify(message.message), message.createdAt ?? TS0);
    }

    for (const call of session.toolCalls ?? []) {
      db.prepare(
        `INSERT INTO tool_calls (session_id, message_seq, tool_call_id, tool_name, args_json, status, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`,
      ).run(session.id, call.messageSeq, call.toolCallId, call.toolName, JSON.stringify(call.args ?? {}), TS0, TS0);
      if (call.output === undefined) continue;
      const rowId = db.prepare(
        'SELECT id FROM tool_calls WHERE session_id = ? AND tool_call_id = ?',
      ).get(session.id, call.toolCallId) as { id: number };
      db.prepare(
        'INSERT INTO tool_results (tool_call_row_id, output_kind, output_json, success, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(rowId.id, 'json', JSON.stringify(call.output), call.success === false ? 0 : 1, TS0);
    }

    for (const usage of session.usage ?? []) {
      db.prepare(
        `INSERT INTO usage_events (session_id, message_seq, source, model, input_tokens, output_tokens, total_tokens, cost_micros, created_at)
         VALUES (?, ?, 'message', ?, ?, ?, ?, ?, ?)`,
      ).run(
        session.id,
        usage.messageSeq,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.inputTokens + usage.outputTokens,
        usage.costMicros ?? 0,
        usage.createdAt ?? TS0,
      );
    }

    for (const compaction of session.compactions ?? []) {
      db.prepare(
        'INSERT INTO compactions (session_id, first_kept_seq, summary, tokens_before, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(session.id, compaction.firstKeptSeq, compaction.summary, compaction.tokensBefore ?? 0, compaction.createdAt ?? TS0);
    }
  }

  db.close();
  return dbPath;
};

export const removeGrokFixtureDb = (dbPath: string): void => {
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
};
