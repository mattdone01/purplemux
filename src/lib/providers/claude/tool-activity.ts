import { createHash } from 'crypto';
import type { IToolActivity } from '@/types/signals';

/**
 * Normalize a Claude Code PostToolUse payload into an IToolActivity.
 *
 * The hook forwards raw JSON rather than a sed-extracted subset, because a
 * Bash command routinely contains quotes and newlines that a shell parser
 * mangles. Every field here is treated as untrusted and optional — a payload
 * shape change must degrade to "no signal", never throw on the hook path.
 */

const FILE_PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

const collectPaths = (toolInput: Record<string, unknown>): string[] => {
  const paths: string[] = [];
  for (const key of FILE_PATH_KEYS) {
    const value = asString(toolInput[key]);
    if (value) paths.push(value);
  }
  // MultiEdit-shaped payloads carry a list of per-file edits.
  const edits = toolInput.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const value = asString(asRecord(edit).file_path);
      if (value) paths.push(value);
    }
  }
  return [...new Set(paths)];
};

/**
 * A command's identity, not its content. Repeats are counted by hash so the
 * engine never retains anything the agent typed.
 */
const commandKeyFor = (command: string): string =>
  createHash('sha256').update(command.trim().replace(/\s+/g, ' ')).digest('hex').slice(0, 16);

const previewFor = (command: string): string => {
  const flat = command.trim().replace(/\s+/g, ' ');
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
};

/**
 * Claude reports a tool failure in more than one shape depending on the tool,
 * so treat any of them as failure and anything unrecognised as success.
 */
const didFail = (payload: Record<string, unknown>): boolean => {
  const response = asRecord(payload.tool_response);
  if (response.interrupted === true) return true;
  if (typeof response.is_error === 'boolean') return response.is_error;
  const code = response.exit_code ?? response.exitCode;
  if (typeof code === 'number') return code !== 0;
  return false;
};

export const parseClaudeToolActivity = (body: unknown): IToolActivity | null => {
  const payload = asRecord(body);
  const tool = asString(payload.tool_name);
  if (!tool) return null;

  const toolInput = asRecord(payload.tool_input);
  const command = asString(toolInput.command);

  return {
    tool,
    paths: collectPaths(toolInput),
    failed: didFail(payload),
    ...(command ? { commandKey: commandKeyFor(command), commandPreview: previewFor(command) } : {}),
  };
};
