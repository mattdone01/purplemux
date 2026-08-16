import { createHash } from 'crypto';
import type { TAgentWorkStateEvent } from '@/lib/providers/types';
import type { IToolActivity } from '@/types/signals';

/**
 * Grok Build's hook envelope is camelCase throughout (`10-hooks.md`, "Porting
 * Claude Code stop hooks"), while the VALUE of `hookEventName` is snake_case
 * (`session_start`, `pre_tool_use`, `stop`). Both spellings are normalised so a
 * release that switches to the PascalCase event name still routes.
 */
export interface IGrokHookPayload {
  hookEventName?: string;
  sessionId?: string;
  cwd?: string | null;
  workspaceRoot?: string | null;
  promptId?: string | null;
  permissionMode?: string;
  source?: string;
  reason?: string;
  notificationType?: string;
  /** Present only inside a subagent's own session — never the session's own state. */
  subagentType?: string;
  prompt?: string | null;
  userPrompt?: string | null;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  trigger?: string;
}

export type TGrokHookEvent =
  | 'session_start'
  | 'session_end'
  | 'user_prompt_submit'
  | 'stop'
  | 'stop_failure'
  | 'stop_cancelled'
  | 'notification'
  | 'pre_compact'
  | 'post_compact'
  | 'post_tool_use';

const CANONICAL_EVENTS: Record<string, TGrokHookEvent> = {
  sessionstart: 'session_start',
  sessionend: 'session_end',
  userpromptsubmit: 'user_prompt_submit',
  stop: 'stop',
  stopfailure: 'stop_failure',
  stopcancelled: 'stop_cancelled',
  notification: 'notification',
  precompact: 'pre_compact',
  postcompact: 'post_compact',
  posttooluse: 'post_tool_use',
};

export const grokHookEvent = (raw: unknown): TGrokHookEvent | null => {
  if (typeof raw !== 'string') return null;
  return CANONICAL_EVENTS[raw.toLowerCase().replace(/[^a-z]/g, '')] ?? null;
};

export const GROK_PERMISSION_NOTIFICATION = 'permission_prompt';
export const GROK_IDLE_NOTIFICATION = 'idle_prompt';
export const GROK_TASK_COMPLETE_NOTIFICATION = 'task_complete';

/**
 * A settle is a turn end grok reports as a state rather than an outcome: the
 * `idle_prompt` ping (which fires after interrupted and errored turns too) and
 * `task_complete`. It only moves a tab that is still busy — see
 * `shouldEmitGrokHookEvent`.
 */
export const isGrokSettleNotification = (notificationType: string | undefined): boolean =>
  notificationType === GROK_IDLE_NOTIFICATION || notificationType === GROK_TASK_COMPLETE_NOTIFICATION;

/**
 * `hookEventName` → purplemux work-state event.
 *
 * `Stop` is a gate that re-fires on each continuation round, but purplemux
 * registers no blocking gate, so its fire is a genuine turn end.
 * `StopCancelled` runs INSTEAD of `Stop` on an interrupt, a declined
 * permission, or a turn limit, which is exactly purplemux's `interrupt`.
 */
export const translateGrokHookEvent = (
  payload: IGrokHookPayload,
): TAgentWorkStateEvent | null => {
  // A subagent's stop is not the session's; reporting it would settle the tab
  // while the parent turn is still running (`10-hooks.md`, state script).
  if (payload.subagentType) return null;

  switch (grokHookEvent(payload.hookEventName)) {
    case 'session_start':
      return { kind: 'session-start' };
    case 'user_prompt_submit':
      return { kind: 'prompt-submit' };
    case 'stop':
    case 'stop_failure':
      return { kind: 'stop' };
    case 'stop_cancelled':
    case 'session_end':
      return { kind: 'interrupt' };
    case 'pre_compact':
      return { kind: 'pre-compact' };
    case 'post_compact':
      return { kind: 'post-compact' };
    case 'notification':
      if (payload.notificationType === GROK_PERMISSION_NOTIFICATION) {
        return { kind: 'notification', notificationType: GROK_PERMISSION_NOTIFICATION };
      }
      return isGrokSettleNotification(payload.notificationType) ? { kind: 'stop' } : null;
    default:
      return null;
  }
};

export const grokPromptText = (payload: IGrokHookPayload): string | null => {
  const prompt = payload.prompt ?? payload.userPrompt;
  return typeof prompt === 'string' && prompt.trim() ? prompt : null;
};

const FILE_PATH_KEYS = ['file_path', 'target_file', 'path', 'filePath', 'notebook_path'] as const;

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
  const edits = toolInput.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const value = asString(asRecord(edit).file_path) ?? asString(asRecord(edit).path);
      if (value) paths.push(value);
    }
  }
  return [...new Set(paths)];
};

/** A command's identity, not its content — repeats are counted by hash. */
const commandKeyFor = (command: string): string =>
  createHash('sha256').update(command.trim().replace(/\s+/g, ' ')).digest('hex').slice(0, 16);

const previewFor = (command: string): string => {
  const flat = command.trim().replace(/\s+/g, ' ');
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
};

/**
 * grok's `run_terminal_command` result carries `exit_code`; a tool that threw
 * reports `type: 'error…'`. Anything unrecognised counts as success so a
 * payload change degrades to "no signal" instead of a false failure.
 */
const didFail = (result: unknown): boolean => {
  const record = asRecord(result);
  const code = record.exit_code ?? record.exitCode;
  if (typeof code === 'number') return code !== 0;
  if (typeof record.success === 'boolean') return !record.success;
  const kind = asString(record.type);
  if (kind) return kind.startsWith('error');
  return false;
};

export const parseGrokToolActivity = (body: unknown): IToolActivity | null => {
  const payload = asRecord(body);
  const tool = asString(payload.toolName);
  if (!tool) return null;

  const toolInput = asRecord(payload.toolInput);
  const command = asString(toolInput.command);

  return {
    tool,
    paths: collectPaths(toolInput),
    failed: didFail(payload.toolResult),
    ...(command ? { commandKey: commandKeyFor(command), commandPreview: previewFor(command) } : {}),
  };
};
