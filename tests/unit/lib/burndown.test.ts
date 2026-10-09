import { describe, expect, it } from 'vitest';
import {
  BURNDOWN_STALE_MS,
  MAX_BURNDOWN_EPICS,
  MAX_BURNDOWN_HISTORY,
  isBurndownStale,
  parseBurndownSnapshot,
} from '@/lib/burndown';

const NOW = Date.parse('2026-10-09T22:40:00Z');

const epic = (overrides: Record<string, unknown> = {}) => ({
  slug: 'bmr-pool-credit-defects', name: 'bmr-bsr-finding-remediation', stories: 9, unpointed: 0,
  total: 16, burned: 8, remaining: 8, pct: 50.0, in_progress: 3, blocked: 0,
  done_events: [{ at: '2026-10-09T12:05:00Z', points: 3 }, { at: '2026-10-09', points: 5 }],
  undated_burned: 0, ...overrides,
});

const row = (overrides: Record<string, unknown> = {}) => ({
  at: '2026-10-09T22:36:41Z', slug: 'bmr-pool-credit-defects', total: 16, burned: 8, remaining: 8,
  pct: 50.0, stories: 9, unpointed: 0, ...overrides,
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  generated_at: '2026-10-09T22:36:41Z', epics: [epic()], history: [row()], ...overrides,
});

const error = (raw: unknown): string => {
  const result = parseBurndownSnapshot(raw, NOW);
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
};

describe('parseBurndownSnapshot', () => {
  it('accepts the generator shape and keeps only known fields', () => {
    const result = parseBurndownSnapshot({ ...snapshot({ epics: [{ ...epic(), extra: 'x' }] }), note: 'ignored' }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot).toEqual(snapshot());
    expect(result.droppedHistory).toBe(0);
  });

  it('refuses a body that is not an object', () => {
    expect(error(null)).toMatch(/body/);
    expect(error([])).toMatch(/body/);
    expect(error('x')).toMatch(/body/);
  });

  it('refuses a generated_at that is not an ISO UTC time or lies in the future', () => {
    expect(error(snapshot({ generated_at: 'yesterday' }))).toMatch(/generated_at/);
    expect(error(snapshot({ generated_at: '2026-10-09' }))).toMatch(/generated_at/);
    expect(error(snapshot({ generated_at: '2026-10-10T22:36:41Z' }))).toMatch(/generated_at.*future/);
  });

  it('names the field, what it saw and what it expected', () => {
    expect(error(snapshot({ epics: [epic({ total: -1 })] })))
      .toBe('epics[0].total: saw -1, expected a non-negative integer');
    expect(error(snapshot({ epics: [epic({ pct: 101 })] })))
      .toBe('epics[0].pct: saw 101, expected a number from 0 to 100');
    expect(error(snapshot({ history: [row(), row({ slug: '' })] })))
      .toMatch(/^history\[1\]\.slug: saw "", expected/);
  });

  it('refuses fractional points, booleans and strings for counts', () => {
    expect(error(snapshot({ epics: [epic({ stories: 2.5 })] }))).toMatch(/epics\[0\]\.stories/);
    expect(error(snapshot({ epics: [epic({ blocked: true })] }))).toMatch(/epics\[0\]\.blocked/);
    expect(error(snapshot({ epics: [epic({ in_progress: '3' })] }))).toMatch(/epics\[0\]\.in_progress/);
  });

  it('refuses arithmetic the generator never writes', () => {
    expect(error(snapshot({ epics: [epic({ remaining: 7 })] })))
      .toBe('epics[0]: saw burned 8 + remaining 7 = 15, expected total 16');
    expect(error(snapshot({ epics: [epic({ undated_burned: 1 })] })))
      .toBe('epics[0]: saw done_events 8 + undated_burned 1 = 9, expected burned 8');
    expect(error(snapshot({ epics: [epic({ unpointed: 10 })] }))).toMatch(/epics\[0\]\.unpointed.*stories 9/);
    expect(error(snapshot({ history: [row({ burned: 9 })] })))
      .toBe('history[0]: saw burned 9 + remaining 8 = 17, expected total 16');
  });

  it('refuses duplicate slugs and bad slugs', () => {
    expect(error(snapshot({ epics: [epic(), epic()] }))).toMatch(/epics\[1\]\.slug.*duplicate/);
    expect(error(snapshot({ epics: [epic({ slug: '../etc' })] }))).toMatch(/epics\[0\]\.slug/);
  });

  it('accepts the hand-written done_at shapes status.yaml carries', () => {
    const done_events = [{ at: '2026-10-09T06:25Z', points: 2 }, { at: '2026-10-09T06:25:07+08:00', points: 2 },
      { at: '2026-10-09', points: 2 }, { at: '2026-10-09T06:25:07.5Z', points: 2 }];
    expect(parseBurndownSnapshot(snapshot({ epics: [epic({ done_events })] }), NOW).ok).toBe(true);
  });

  it('refuses malformed done events', () => {
    expect(error(snapshot({ epics: [epic({ done_events: [{ at: '2026-10-09T06:25', points: 8 }] })] })))
      .toMatch(/epics\[0\]\.done_events\[0\]\.at/);
    expect(error(snapshot({ epics: [epic({ done_events: [{ at: 'soon', points: 8 }] })] })))
      .toMatch(/epics\[0\]\.done_events\[0\]\.at/);
    expect(error(snapshot({ epics: [epic({ done_events: 'none' })] }))).toMatch(/epics\[0\]\.done_events/);
  });

  it('caps the epic count', () => {
    const epics = Array.from({ length: MAX_BURNDOWN_EPICS + 1 }, (_, index) =>
      epic({ slug: `epic-${index}`, done_events: [], undated_burned: 8 }));
    expect(error(snapshot({ epics, history: [] }))).toMatch(new RegExp(`epics: saw ${MAX_BURNDOWN_EPICS + 1} entries`));
  });

  it('keeps the newest history rows, ordered by time', () => {
    const rows = Array.from({ length: MAX_BURNDOWN_HISTORY + 5 }, (_, index) =>
      row({ at: new Date(Date.parse('2026-01-01T00:00:00Z') + index * 60_000).toISOString().replace('.000', '') }));
    const result = parseBurndownSnapshot(snapshot({ history: [...rows].reverse() }), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.history).toHaveLength(MAX_BURNDOWN_HISTORY);
    expect(result.droppedHistory).toBe(5);
    expect(result.snapshot.history[0].at).toBe(rows[5].at);
    expect(result.snapshot.history.at(-1)?.at).toBe(rows.at(-1)?.at);
  });

  it('accepts an empty fleet', () => {
    const result = parseBurndownSnapshot(snapshot({ epics: [], history: [] }), NOW);
    expect(result.ok && result.snapshot.epics).toEqual([]);
  });
});

describe('isBurndownStale', () => {
  it('marks a snapshot older than two hours', () => {
    const generated = '2026-10-09T20:00:00Z';
    expect(isBurndownStale(generated, Date.parse(generated) + BURNDOWN_STALE_MS)).toBe(false);
    expect(isBurndownStale(generated, Date.parse(generated) + BURNDOWN_STALE_MS + 1)).toBe(true);
  });
});
