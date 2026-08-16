import {
  grokHookEvent,
  grokPromptText,
  isGrokSettleNotification,
  translateGrokHookEvent,
  type IGrokHookPayload,
} from '@/lib/providers/grok/hook-payload';
import type { IAgentHookTranslation } from '@/lib/providers/types';
import type { TCliState } from '@/types/timeline';

const SUMMARY_LIMIT = 80;

export interface IHandleGrokHookResult {
  ok: boolean;
  reason?: 'unknown-event' | 'subagent';
}

/**
 * Converts Grok Build's hook payload into purplemux's provider-neutral
 * translation. `jsonlPath` is not patched here: the hook carries the session id
 * and cwd, and the transcript path is resolved from those by session detection.
 */
export const processGrokHookPayload = (
  payload: IGrokHookPayload,
): { result: IHandleGrokHookResult; translation: IAgentHookTranslation } => {
  const meta: NonNullable<IAgentHookTranslation['meta']> = {
    sessionId: payload.sessionId ?? null,
  };

  const event = grokHookEvent(payload.hookEventName);
  const prompt = event === 'user_prompt_submit' ? grokPromptText(payload) : null;
  if (prompt) {
    meta.lastUserMessage = prompt;
    meta.agentSummary = prompt.slice(0, SUMMARY_LIMIT);
  }

  const translation: IAgentHookTranslation = { meta };

  if (payload.subagentType) {
    return { result: { ok: false, reason: 'subagent' }, translation };
  }

  if (event === 'session_start') {
    translation.sessionInfo = {
      status: 'running',
      sessionId: payload.sessionId ?? null,
      jsonlPath: null,
      pid: null,
      startedAt: null,
      cwd: payload.cwd ?? payload.workspaceRoot ?? null,
    };
  }

  const workEvent = translateGrokHookEvent(payload);
  translation.event = workEvent;
  if (!workEvent) return { result: { ok: false, reason: 'unknown-event' }, translation };

  return { result: { ok: true }, translation };
};

/**
 * `idle_prompt` reports a STATE, not an outcome: grok fires it about a minute
 * after any turn end, including one already settled by `Stop`, and it is the
 * only signal for the turns that report no stop at all. Settling on it
 * unconditionally would drag a tab the user has since re-prompted back out of
 * `busy`, so it only lands while the tab is still busy.
 */
export const shouldEmitGrokHookEvent = (
  payload: IGrokHookPayload,
  cliState: TCliState,
): boolean => {
  const event = translateGrokHookEvent(payload);
  if (!event) return false;
  if (grokHookEvent(payload.hookEventName) === 'notification' && isGrokSettleNotification(payload.notificationType)) {
    return cliState === 'busy';
  }
  return true;
};
