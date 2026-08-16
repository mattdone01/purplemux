import {
  isGrokSessionSource,
  translateGrokHookEvent,
  type IGrokHookPayload,
} from '@/lib/providers/grok/hook-payload';
import type { IAgentHookTranslation } from '@/lib/providers/types';
import type { TCliState } from '@/types/timeline';

const SUMMARY_LIMIT = 80;

export interface IHandleGrokHookResult {
  ok: boolean;
  reason?: 'unknown-event';
}

/**
 * Converts grok's hook payload into purplemux's provider-neutral translation.
 * grok has no transcript file, so `jsonlPath` is never patched — the timeline
 * reads `~/.grok/grok.db` keyed on the session id instead.
 */
export const processGrokHookPayload = (
  payload: IGrokHookPayload,
): { result: IHandleGrokHookResult; translation: IAgentHookTranslation } => {
  const meta: NonNullable<IAgentHookTranslation['meta']> = {
    sessionId: payload.session_id ?? null,
  };

  if (payload.hook_event_name === 'UserPromptSubmit' && typeof payload.user_prompt === 'string' && payload.user_prompt) {
    meta.lastUserMessage = payload.user_prompt;
    meta.agentSummary = payload.user_prompt.slice(0, SUMMARY_LIMIT);
  }

  const translation: IAgentHookTranslation = { meta };

  if (payload.hook_event_name === 'SessionStart') {
    translation.sessionInfo = {
      status: 'running',
      sessionId: payload.session_id ?? null,
      jsonlPath: null,
      pid: null,
      startedAt: null,
      cwd: payload.cwd ?? null,
    };
  }

  const event = translateGrokHookEvent(payload);
  translation.event = event;
  if (!event) return { result: { ok: false, reason: 'unknown-event' }, translation };

  return { result: { ok: true }, translation };
};

/**
 * grok fires `SessionStart` lazily, on the first prompt of a session rather
 * than at launch, so a late one must not knock a busy tab back to idle.
 */
export const shouldEmitGrokHookEvent = (
  payload: IGrokHookPayload,
  cliState: TCliState,
): boolean => {
  const event = translateGrokHookEvent(payload);
  if (!event) return false;
  if (event.kind === 'session-start') {
    const source = isGrokSessionSource(payload.source) ? payload.source : 'startup';
    return source === 'startup' && (cliState === 'inactive' || cliState === 'unknown');
  }
  return true;
};
