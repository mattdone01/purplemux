import { describe, expect, it } from 'vitest';
import {
  ATTENTION_CLASSES,
  ATTENTION_CLASS_KEYS,
  ATTENTION_CLASS_LABELS,
  attentionClassKey,
  isAttentionClass,
} from '@/lib/attention-class';

describe('attention class vocabulary (ADR-0031)', () => {
  it('orders the classes money first and unclassified last', () => {
    expect(ATTENTION_CLASSES).toEqual(['money', 'irreversible', 'scope', 'bookkeeping']);
    expect(ATTENTION_CLASS_KEYS.map((key) => ATTENTION_CLASS_LABELS[key]))
      .toEqual(['Money', 'Irreversible', 'Scope', 'Bookkeeping', 'Unclassified']);
  });

  it.each(ATTENTION_CLASSES)('recognises %s', (value) => {
    expect(isAttentionClass(value)).toBe(true);
    expect(attentionClassKey(value)).toBe(value);
  });

  it.each([null, undefined, '', 'unclassified', 'Money', 'constructor', 'toString', '__proto__', 7, {}])(
    'maps %s to unclassified, never to a guessed class',
    (value) => {
      expect(isAttentionClass(value)).toBe(false);
      expect(attentionClassKey(value)).toBe('unclassified');
    },
  );
});
