import { describe, expect, it } from 'vitest';
import { TURN_MARKER_NAMES, parseReportOn, reportOnAdmits, turnMarkerName } from '@/lib/turn-end';

// ADR-0025: a per-tab list of the markers whose end lines are forwarded. The
// parser is shared by the create and patch routes; the admission by the stop
// classifier.

describe('parseReportOn', () => {
  it('names the five markers without their colon, in marker order', () => {
    expect(TURN_MARKER_NAMES).toEqual(['DONE', 'BLOCKED', 'NEEDS-DECISION', 'READY-TO-MERGE', 'CHECKPOINTED']);
  });

  it.each<[string, unknown, string[] | null]>([
    ['a comma-separated string', 'DONE,BLOCKED', ['DONE', 'BLOCKED']],
    ['an array', ['BLOCKED', 'DONE'], ['DONE', 'BLOCKED']],
    ['lower case, spaces and colons', ' done:, needs-decision ', ['DONE', 'NEEDS-DECISION']],
    ['duplicates', 'DONE,DONE,BLOCKED', ['DONE', 'BLOCKED']],
    ['all', 'all', null],
    ['ALL inside a list', 'DONE,ALL', null],
    ['null', null, null],
    ['undefined', undefined, null],
  ])('accepts %s', (_what, value, markers) => {
    expect(parseReportOn(value)).toEqual({ ok: true, markers });
  });

  it.each<[string, unknown]>([
    ['an unknown name', 'DONE,FINISHED'],
    ['an empty string', ''],
    ['only separators', ' , '],
    ['an empty array', []],
    ['a number', 7],
    ['a non-string element', ['DONE', 7]],
  ])('refuses %s with a reason', (_what, value) => {
    const parsed = parseReportOn(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/reportOn/);
  });
});

describe('reportOnAdmits', () => {
  it('forwards every marker when the tab has no list', () => {
    for (const name of TURN_MARKER_NAMES) {
      expect(reportOnAdmits(null, [`${name}: x`])).toBe(true);
      expect(reportOnAdmits(undefined, [`${name}: x`])).toBe(true);
      expect(reportOnAdmits([], [`${name}: x`])).toBe(true);
    }
  });

  it('judges the LAST line: READY-TO-MERGE lines above a DONE ride with the DONE', () => {
    const lines = ['READY-TO-MERGE: #12', 'DONE: shipped'];
    expect(reportOnAdmits(['DONE'], lines)).toBe(true);
    expect(reportOnAdmits(['READY-TO-MERGE'], lines)).toBe(false);
    expect(reportOnAdmits(['READY-TO-MERGE'], ['READY-TO-MERGE: #12'])).toBe(true);
  });

  it('withholds a marker outside the list', () => {
    expect(reportOnAdmits(['DONE', 'BLOCKED'], ['CHECKPOINTED: next is the landing'])).toBe(false);
    expect(reportOnAdmits(['DONE', 'BLOCKED'], ['BLOCKED: gate red'])).toBe(true);
  });

  it('never forwards a line that is not a marker line, whatever the list', () => {
    expect(reportOnAdmits(['DONE'], ['all good'])).toBe(false);
    expect(reportOnAdmits(['DONE'], [])).toBe(false);
    expect(turnMarkerName('all good')).toBeNull();
    expect(turnMarkerName('DONE: x')).toBe('DONE');
    expect(turnMarkerName('DONE-ish: x')).toBeNull();
  });
});
