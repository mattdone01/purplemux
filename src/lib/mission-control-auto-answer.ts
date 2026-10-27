import type { IMissionAttentionItem } from '@/types/mission-control';

// The bookkeeping auto-answer rule (ADR-0031 §4-§8): pure parts only, so the
// store can re-check eligibility inside the answer transaction.

export const AUTO_ANSWER_KEY = 'attention.auto-answer.bookkeeping-minutes';
const AUTO_ANSWER_MAX_MINUTES = 10_080;
const MINUTE_MS = 60_000;

export interface IAutoAnswerRule {
  minutes: number;
  /** The fleet-config version of the key: the rule version the note and the record carry. */
  version: number;
}

/** Unset is off; any value that is not an integer in 1..10080 is off, with the reason to log. */
export const parseAutoAnswerMinutes = (raw: string | null): { minutes: number | null; reason: string | null } => {
  if (raw === null) return { minutes: null, reason: null };
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    return { minutes: null, reason: `${AUTO_ANSWER_KEY} is ${JSON.stringify(raw)}, not an integer; the rule is off` };
  }
  const minutes = Number(text);
  if (minutes < 1 || minutes > AUTO_ANSWER_MAX_MINUTES) {
    return { minutes: null, reason: `${AUTO_ANSWER_KEY} is ${minutes}, outside 1..${AUTO_ANSWER_MAX_MINUTES}; the rule is off` };
  }
  return { minutes, reason: null };
};

/**
 * Why the rule must not answer this item now, or null when it may. Only an open,
 * human-reviewed `bookkeeping` question whose stated default names a current
 * option, unchanged for at least N minutes, qualifies.
 */
export const autoAnswerRefusal = (item: IMissionAttentionItem, rule: IAutoAnswerRule, now: number): string | null => {
  if (item.state !== 'open') return 'attention item is no longer open';
  if (!item.humanReview || item.humanReview.humanNeed === 'none') return 'attention item is not eligible for a human answer';
  if (item.class !== 'bookkeeping') return 'only a bookkeeping item is auto-answered';
  if (item.kind === 'action') return 'an action item is never auto-answered';
  if (item.defaultOptionId === null || !item.options.some((option) => option.id === item.defaultOptionId)) {
    return 'attention item states no current default option';
  }
  if (now - item.updatedAt < rule.minutes * MINUTE_MS) return 'attention item is younger than the rule';
  return null;
};

export const autoAnswerSubmissionId = (itemId: string, revision: number): string => `auto:${itemId}:${revision}`;

export const autoAnswerNote = (rule: IAutoAnswerRule, at: number, optionLabel: string): string =>
  `Auto-answered under fleet config ${AUTO_ANSWER_KEY}=${rule.minutes} (version ${rule.version}) at ${new Date(at).toISOString()}: applied the stated default "${optionLabel}".`;
