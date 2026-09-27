import { describe, expect, it } from 'vitest';
import { NUDGE_DEDUPE_WINDOW_MS, NudgeDeduper, type INudgeIdentity } from '@/lib/nudge-dedupe';

// L49 and review r1 finding 3: a repeat of the same episode within 60 s per
// (source tab, recipient, class, episode) is dropped and counted; a new
// episode, class, recipient or source always goes out, whatever its text.

const nudge = (over: Partial<INudgeIdentity> = {}): INudgeIdentity => ({
  sourceTabId: 'tab-w',
  recipientTabId: 'tab-o',
  kind: 'bg-completed',
  episode: 'pid:42',
  ...over,
});

describe('NudgeDeduper', () => {
  it('drops the second identical nudge inside 60 s and counts it', () => {
    const d = new NudgeDeduper();
    expect(d.admit(nudge(), 1_000)).toBe(true);
    expect(d.admit(nudge(), 1_000 + NUDGE_DEDUPE_WINDOW_MS - 1)).toBe(false);
    expect(d.dropped).toBe(1);
  });

  it('admits the same nudge again once 60 s have passed since the first', () => {
    const d = new NudgeDeduper();
    expect(d.admit(nudge(), 0)).toBe(true);
    expect(d.admit(nudge(), 30_000)).toBe(false);
    expect(d.admit(nudge(), NUDGE_DEDUPE_WINDOW_MS)).toBe(true);
    expect(d.dropped).toBe(1);
  });

  it.each<[string, Partial<INudgeIdentity>]>([
    ['a different episode (another job)', { episode: 'pid:43' }],
    ['a different class', { kind: 'bg-failed' }],
    ['a different recipient', { recipientTabId: 'tab-o2' }],
    ['a different source tab', { sourceTabId: 'tab-w2' }],
  ])('never drops %s', (_what, over) => {
    const d = new NudgeDeduper();
    expect(d.admit(nudge(), 0)).toBe(true);
    expect(d.admit(nudge(over), 1)).toBe(true);
    expect(d.dropped).toBe(0);
  });

  it('keys on the fields, not on a joined string two different nudges could share', () => {
    const d = new NudgeDeduper();
    expect(d.admit(nudge({ sourceTabId: 'a|b', recipientTabId: 'c' }), 0)).toBe(true);
    expect(d.admit(nudge({ sourceTabId: 'a', recipientTabId: 'b|c' }), 0)).toBe(true);
  });
});
