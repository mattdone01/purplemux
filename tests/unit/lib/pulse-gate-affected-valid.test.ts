import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IPulseTargets } from '@/lib/pulse-scope';
import { clearVerdictCacheForTests, parseGateShLog, readGates } from '@/lib/pulse-sources';

// Story VG-5 (engineering ADR-V1 D4): a gate that ran only the tests that reach the diff ends
// `VERDICT=AFFECTED-VALID (...)`. It is not a merge verdict. The pulse gate reader counts `VALID` with
// `EXIT=0` as a pass; it gives AFFECTED-VALID no outcome (null), so `gatesPassed` never mixes a subset
// run with a full one. Counting it later takes its own outcome (ruling vg-5-design-check, change 5).

const HOUR = 3_600_000;
const NOW = Date.now();
const SINCE = NOW - 169 * HOUR;

/** The D4 trailer in full, with the header line gate.sh writes after START=. */
const AFFECTED =
  'AFFECTED-VALID (12 of 73 test files, base 0123456789ab; not a merge verdict: the full suite runs at the integration gate and in CI)';
const SELECTED = 'SELECTION=affected files=12 of 73 lanes=skills-test:12/66 base=0123456789ab changed=5 seconds=1.8';
const log = (verdict: string, exit = '0'): string =>
  `START=${new Date(NOW - 2 * HOUR).toISOString()}\n${SELECTED}\nCMD=make precommit\nEND=${new Date(NOW - HOUR).toISOString()}\nSETTLED=yes\nEXIT=${exit}\nVERDICT=${verdict}\n`;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-affected-'));
  clearVerdictCacheForTests();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  clearVerdictCacheForTests();
});

const targets = (over: Partial<IPulseTargets> = {}): IPulseTargets => ({
  repos: [], libraryGateDirs: [], libraryReviewDirs: [], v2Dirs: [], ...over,
});

describe('parseGateShLog and AFFECTED-VALID', () => {
  it('gives the full trailer and the bare word no outcome, with EXIT=0 and settled', () => {
    expect(parseGateShLog(log(AFFECTED))).toBeNull();
    expect(parseGateShLog(log('AFFECTED-VALID'))).toBeNull();
  });

  it('a VALID a test printed mid-run never answers for an AFFECTED-VALID trailer, and the reverse stays a pass', () => {
    const printed = (first: string, last: string): string => log(last).replace('CMD=make precommit\n', `CMD=make precommit\nVERDICT=${first}\n`);
    expect(parseGateShLog(printed('VALID', AFFECTED))).toBeNull();
    expect(parseGateShLog(printed(AFFECTED, 'VALID'))?.outcome).toBe('pass');
  });

  it('near misses are not passes either; RED in a subset run is a true fail', () => {
    for (const verdict of ['AFFECTED-VALID(x)', 'VALID-AFFECTED', 'affected-valid', 'AFFECTED-VALIDX']) {
      expect(parseGateShLog(log(verdict))).toBeNull();
    }
    expect(parseGateShLog(log('RED (lanes in scope: skills-test)', '2'))?.outcome).toBe('fail');
  });

  it('readGates counts no event for an AFFECTED-VALID log beside a VALID one', async () => {
    const dir = path.join(root, '_output/epic/evidence/gates');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'vg-5-r1.log'), log(AFFECTED));
    fs.writeFileSync(path.join(dir, 'int-r1.log'), log('VALID'));

    const result = await readGates(targets({ libraryGateDirs: [dir] }), SINCE);

    expect(result.events).toEqual([expect.objectContaining({ outcome: 'pass' })]);
  });
});
