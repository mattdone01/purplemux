import { createHash } from 'crypto';
import type { TAgentWorkStateEvent } from '@/lib/providers/types';
import type { IToolActivity } from '@/types/signals';

export type TGrokHookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'StopFailure'
  | 'Notification'
  | 'PreCompact'
  | 'PostCompact'
  | 'PostToolUse';

export type TGrokSessionSource = 'startup' | 'resume';

export interface IGrokHookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string | null;
  source?: string;
  user_prompt?: string | null;
  message?: string | null;
  error?: string | null;
  trigger?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
}

export const isGrokSessionSource = (value: unknown): value is TGrokSessionSource =>
  value === 'startup' || value === 'resume';

/**
 * grok-cli 1.1.7 fires `Notification` from one place only —
 * `consumeBackgroundNotifications()`, which reports a finished background
 * delegation. Its payload carries `message` and nothing else: there is no
 * `notification_type`, and grok has no permission-prompt hook at all. Treating
 * every `Notification` as needs-input would therefore park a still-working tab
 * in the wrong state, so the mapping is gated on the message reading like a
 * request for the operator. Today nothing grok emits matches; the gate exists
 * so a future grok release that adds permission prompts is picked up without a
 * protocol change.
 */
const PERMISSION_NOTIFICATION_RE = /\b(permission|approval|approve|authorize|confirm)\b/i;

export const isGrokPermissionNotification = (message: string | null | undefined): boolean =>
  typeof message === 'string' && PERMISSION_NOTIFICATION_RE.test(message);

export const translateGrokHookEvent = (
  payload: IGrokHookPayload,
): TAgentWorkStateEvent | null => {
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return { kind: 'session-start' };
    case 'UserPromptSubmit':
      return { kind: 'prompt-submit' };
    case 'Stop':
    case 'StopFailure':
      return { kind: 'stop' };
    case 'SessionEnd':
      return { kind: 'interrupt' };
    case 'PreCompact':
      return { kind: 'pre-compact' };
    case 'PostCompact':
      return { kind: 'post-compact' };
    case 'Notification':
      return isGrokPermissionNotification(payload.message)
        ? { kind: 'notification', notificationType: 'permission_prompt' }
        : null;
    default:
      return null;
  }
};

const FILE_PATH_KEYS = ['path', 'file_path', 'filePath', 'notebook_path'] as const;

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
      const value = asString(asRecord(edit).path) ?? asString(asRecord(edit).file_path);
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
 * grok reports a tool outcome as the AI-SDK output envelope — `{success, …}`
 * for its own tools, `{type:'error-text'|'error-json', value}` for a thrown
 * one. Anything unrecognised counts as success so a payload change degrades to
 * "no signal" instead of a false failure.
 */
const didFail = (output: unknown): boolean => {
  const record = asRecord(output);
  if (typeof record.success === 'boolean') return !record.success;
  const kind = asString(record.type);
  if (kind) return kind.startsWith('error');
  const code = record.exit_code ?? record.exitCode;
  if (typeof code === 'number') return code !== 0;
  return false;
};

export const parseGrokToolActivity = (body: unknown): IToolActivity | null => {
  const payload = asRecord(body);
  const tool = asString(payload.tool_name);
  if (!tool) return null;

  const toolInput = asRecord(payload.tool_input);
  const command = asString(toolInput.command);

  return {
    tool,
    paths: collectPaths(toolInput),
    failed: didFail(payload.tool_output),
    ...(command ? { commandKey: commandKeyFor(command), commandPreview: previewFor(command) } : {}),
  };
};
