import type { TAttentionClass } from '@/types/mission-control';

/** Display and grouping order: money first (ADR-0031 §2). */
export const ATTENTION_CLASSES = ['money', 'irreversible', 'scope', 'bookkeeping'] as const satisfies readonly TAttentionClass[];

export type TAttentionClassKey = TAttentionClass | 'unclassified';

export const ATTENTION_CLASS_KEYS: readonly TAttentionClassKey[] = [...ATTENTION_CLASSES, 'unclassified'];

export const ATTENTION_CLASS_LABELS: Readonly<Record<TAttentionClassKey, string>> = {
  money: 'Money',
  irreversible: 'Irreversible',
  scope: 'Scope',
  bookkeeping: 'Bookkeeping',
  unclassified: 'Unclassified',
};

/** The answer actor of the bookkeeping rule (ADR-0031 §6); every other actor is a human. */
export const MISSION_AUTO_ANSWER_ACTOR = 'system:auto-answer';

export const isAttentionClass = (value: unknown): value is TAttentionClass =>
  typeof value === 'string' && (ATTENTION_CLASSES as readonly string[]).includes(value);

/** A served value outside the vocabulary groups as unclassified; it is never mapped to a guessed class. */
export const attentionClassKey = (value: unknown): TAttentionClassKey =>
  isAttentionClass(value) ? value : 'unclassified';
