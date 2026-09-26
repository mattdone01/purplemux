import {
  HOOK_EVENT_KINDS,
  SESSION_START_SOURCES,
  type TAgentWorkStateEvent,
  type THookEventKind,
  type TSessionStartSource,
} from '@/lib/providers/types';

const HOOK_EVENT_KIND_SET: ReadonlySet<string> = new Set(HOOK_EVENT_KINDS);

const isHookEventKind = (event: string): event is THookEventKind =>
  HOOK_EVENT_KIND_SET.has(event);

const isSessionStartSource = (value: unknown): value is TSessionStartSource =>
  typeof value === 'string' && (SESSION_START_SOURCES as readonly string[]).includes(value);

export const translateClaudeHookEvent = (
  event: string,
  notificationType?: string,
  source?: unknown,
): TAgentWorkStateEvent | null => {
  if (!isHookEventKind(event)) return null;
  if (event === 'notification') {
    return notificationType ? { kind: 'notification', notificationType } : { kind: 'notification' };
  }
  if (event === 'session-start') return isSessionStartSource(source) ? { kind: 'session-start', source } : { kind: 'session-start' };
  return { kind: event };
};
