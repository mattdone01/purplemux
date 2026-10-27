import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// ADR-0016 holds ONE code → exit table, and `bin/cli.js` CODE_EXIT is its source. Each story
// appends its own rows, so one exit class may have many rows; every code under every row counts.
//
// The rule for codes CODE_EXIT leaves out: the CLI exits 1 for every unmapped code (ADR-0016 §1),
// so an exit-1 row may name a server code that CODE_EXIT leaves out (`flow-write-failed`). Any
// other row code must be in CODE_EXIT with that row's exit.

const ADR = path.resolve('docs/adr/0016-cli-exit-codes-and-tab-owned-processes.md');
const API_GUIDE = path.resolve('src/pages/api/cli/api-guide.ts');
const CLI = path.resolve('bin/cli.js');

const CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

type TCodeExit = Record<string, number>;

interface IExitRow {
  exit: number;
  codes: string[];
}

/** CODE_EXIT as bin/cli.js exports it, read in a child with no HOME so no real store is read. */
const readCodeExit = (): TCodeExit => {
  const stdout = execFileSync(
    process.execPath,
    ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(CLI)}).CODE_EXIT))`],
    { env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: '/nonexistent', NO_UPDATE_NOTIFIER: '1' }, encoding: 'utf-8' },
  );
  return JSON.parse(stdout) as TCodeExit;
};

/** Every row of the ADR-0016 exit table: its exit and each back-quoted code in its Codes cell. */
const parseAdrTable = (markdown: string): IExitRow[] => {
  const lines = markdown.split('\n');
  const header = lines.findIndex((line) => /^\| Exit \| Meaning \| Codes \| Retry\? \|$/.test(line.trim()));
  if (header === -1) throw new Error('ADR-0016 has no "| Exit | Meaning | Codes | Retry? |" table');
  const rows: IExitRow[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const exit = Number(cells[0]);
    if (!Number.isInteger(exit)) throw new Error(`ADR-0016 exit table row has no exit: ${line}`);
    const codes = [...(cells[2] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((token) => CODE.test(token));
    rows.push({ exit, codes });
  }
  return rows;
};

/**
 * Every row of the api-guide exit table, read from the Codes column only. The `codes` and
 * `retry?` header words give the column offsets; a cell that runs into a neighbouring column is
 * refused, so a code is never read from the Meaning or Retry text. A row starts at a
 * right-aligned exit digit and the lines under it continue it. In a cell, parenthesized text is
 * prose; a word is a code when it carries a hyphen or is a CODE_EXIT code.
 */
const parseGuideTable = (guide: string, known: ReadonlySet<string>): IExitRow[] => {
  const start = guide.indexOf('to an exit code through one table:');
  const end = guide.indexOf('The CLI writes the code and its class to stderr');
  if (start === -1 || end <= start) throw new Error('api-guide has no "Errors and exit codes" table');
  const lines = guide.slice(start, end).split('\n');
  const header = lines.find((line) => /^ +exit +meaning +codes +retry\? *$/.test(line));
  if (!header) throw new Error('api-guide exit table has no "exit  meaning  codes  retry?" header');
  const codesAt = header.indexOf('codes');
  const retryAt = header.indexOf('retry?');
  const rows: { exit: number; cells: string[] }[] = [];
  for (const line of lines.slice(lines.indexOf(header) + 1)) {
    if (!line.trim()) continue;
    if (line.length > codesAt && line[codesAt - 1] !== ' ') throw new Error(`api-guide exit table: the Meaning text runs into the Codes column: ${line}`);
    if (line.length > retryAt && line[retryAt - 1] !== ' ') throw new Error(`api-guide exit table: a Codes cell runs into the Retry column: ${line}`);
    const head = line.match(/^ +(\d) {2}/);
    if (head) rows.push({ exit: Number(head[1]), cells: [] });
    rows.at(-1)?.cells.push(line.slice(codesAt, retryAt));
  }
  return rows.map(({ exit, cells }) => ({
    exit,
    codes: (cells.join(' ').replace(/\([^)]*\)/g, ' ').match(/[a-z][a-z0-9-]*/g) ?? [])
      .filter((word) => CODE.test(word) && (word.includes('-') || known.has(word))),
  }));
};

const pairs = (rows: IExitRow[]): Set<string> => new Set(rows.flatMap((row) => row.codes.map((code) => `${code}=${row.exit}`)));

/** `missing` = CODE_EXIT entries no row names with their exit; `extra` = row entries CODE_EXIT does not hold. */
const diffTable = (codeExit: TCodeExit, rows: IExitRow[]): string => {
  const documented = pairs(rows);
  const mapped = new Set(Object.entries(codeExit).map(([code, exit]) => `${code}=${exit}`));
  const missing = [...mapped].filter((pair) => !documented.has(pair)).sort();
  const extra = [...documented]
    .filter((pair) => {
      if (mapped.has(pair)) return false;
      const [code, exit] = pair.split('=');
      return !(exit === '1' && !Object.hasOwn(codeExit, code));
    })
    .sort();
  return `missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`;
};

const SYNCED = 'missing=[] extra=[]';

describe('ADR-0016 exit table against bin/cli.js CODE_EXIT', () => {
  const codeExit = readCodeExit();

  it('reads CODE_EXIT from bin/cli.js without running the CLI', () => {
    expect(codeExit['tab-not-found']).toBe(4);
    expect(codeExit['readiness-timeout']).toBe(5);
    expect(Object.keys(codeExit).length).toBeGreaterThan(40);
  });

  it('names every CODE_EXIT code with its exit, and nothing else', () => {
    expect(diffTable(codeExit, parseAdrTable(fs.readFileSync(ADR, 'utf-8')))).toBe(SYNCED);
  });

  it('names the same codes in the api-guide exit table', () => {
    const guide = fs.readFileSync(API_GUIDE, 'utf-8');
    const rows = parseGuideTable(guide, new Set(Object.keys(codeExit)));
    expect(diffTable(codeExit, rows)).toBe(SYNCED);
  });

  it('misses a code dropped from the api-guide Codes cell although the Meaning cell still says it', () => {
    const guide = fs.readFileSync(API_GUIDE, 'utf-8');
    const cell = '     3  conflict / refused by state              conflict, unauthorized, forbidden,';
    expect(guide).toContain(cell);
    const dropped = guide.replace(cell, cell.replace('conflict, unauthorized', 'unauthorized,'.padEnd('conflict, unauthorized'.length)));
    expect(diffTable(codeExit, parseGuideTable(dropped, new Set(Object.keys(codeExit))))).toBe('missing=[conflict=3] extra=[]');
  });
});

describe('the exit-table comparison', () => {
  const codeExit: TCodeExit = { 'tab-not-found': 4, 'lease-held': 3, forbidden: 3, 'flow-invalid': 2 };
  const table = (rows: string[]): string =>
    ['| Exit | Meaning | Codes | Retry? |', '|---|---|---|---|', ...rows, '', 'after the table'].join('\n');

  it('passes on a synced table whose exit class spans several rows', () => {
    const rows = parseAdrTable(table([
      '| 3 | conflict | `lease-held` | after the state changes |',
      '| 4 | target gone | `tab-not-found` | **never** |',
      '| 3 | conflict (ADR-0027) | `forbidden` | after the state changes |',
      '| 2 | usage error (flow, ADR-0026) | `flow-invalid` (see `flow show`) | fix the command |',
    ]));
    expect(rows.filter((row) => row.exit === 3).flatMap((row) => row.codes)).toEqual(['lease-held', 'forbidden']);
    expect(diffTable(codeExit, rows)).toBe(SYNCED);
  });

  it('names a missing code, an extra code and a code under the wrong exit', () => {
    const rows = parseAdrTable(table([
      '| 3 | conflict | `lease-held`, `grant-locked` | — |',
      '| 2 | usage error | `tab-not-found`, `flow-invalid` | — |',
    ]));
    expect(diffTable(codeExit, rows)).toBe('missing=[forbidden=3, tab-not-found=4] extra=[grant-locked=3, tab-not-found=2]');
  });

  it('allows an exit-1 code CODE_EXIT leaves out, and nowhere else', () => {
    const rows = parseAdrTable(table([
      '| 1 | unexpected error | `flow-write-failed` | investigate |',
      '| 3 | conflict | `lease-held`, `forbidden`, `config-store-unreadable` | — |',
      '| 4 | target gone | `tab-not-found` | never |',
      '| 2 | usage error | `flow-invalid` | — |',
    ]));
    expect(diffTable(codeExit, rows)).toBe('missing=[] extra=[config-store-unreadable=3]');
  });

  it('refuses an exit-1 row for a code CODE_EXIT maps elsewhere', () => {
    const rows = parseAdrTable(table([
      '| 1 | unexpected error | `lease-held` | investigate |',
      '| 3 | conflict | `forbidden` | — |',
      '| 4 | target gone | `tab-not-found` | never |',
      '| 2 | usage error | `flow-invalid` | — |',
    ]));
    expect(diffTable(codeExit, rows)).toBe('missing=[lease-held=3] extra=[lease-held=1]');
  });

  it('refuses a document with no exit table', () => {
    expect(() => parseAdrTable('# ADR\n\nno table here\n')).toThrow('has no');
  });

  const guideTable = (rows: string[]): string => [
    'to an exit code through one table:',
    '',
    '  exit  meaning           codes                       retry?',
    ...rows,
    '',
    'The CLI writes the code and its class to stderr, e.g.',
  ].join('\n');

  it('reads api-guide codes from the Codes column only', () => {
    const rows = parseGuideTable(guideTable([
      '     3  conflict          lease-held, forbidden       after the state changes',
      '     4  tab-not-found     target gone                 tab-not-found',
      '     2  usage error       flow-invalid (see tab-busy) fix the command',
    ]), new Set(Object.keys(codeExit)));
    expect(diffTable(codeExit, rows)).toBe('missing=[tab-not-found=4] extra=[]');
  });

  it('names a hyphenated api-guide code CODE_EXIT lacks as extra', () => {
    const rows = parseGuideTable(guideTable([
      '     3  conflict          lease-held, forbidden,      after the state changes',
      '                          grant-locked',
      '     4  target gone       tab-not-found               NEVER',
      '     2  usage error       flow-invalid                fix the command',
      '     1  unexpected        flow-write-failed           investigate',
    ]), new Set(Object.keys(codeExit)));
    expect(diffTable(codeExit, rows)).toBe('missing=[] extra=[grant-locked=3]');
  });

  it('refuses an api-guide cell that runs into the next column', () => {
    const known = new Set(Object.keys(codeExit));
    expect(() => parseGuideTable(guideTable(['     3  conflict          lease-held, forbidden, tab-not-found after']), known))
      .toThrow('runs into the Retry column');
    expect(() => parseGuideTable(guideTable(['     3  refused by the statelease-held                  after']), known))
      .toThrow('runs into the Codes column');
  });

  it('collects api-guide codes from a row and its continuation lines', () => {
    const guide = [
      'to an exit code through one table:',
      '',
      '  exit  meaning           codes                       retry?',
      '     3  conflict          lease-held,                 after the state changes',
      '                          forbidden',
      '     4  target gone       tab-not-found               NEVER',
      '     2  usage error       flow-invalid                fix the command',
      '',
      'The CLI writes the code and its class to stderr, e.g.',
    ].join('\n');
    const rows = parseGuideTable(guide, new Set(Object.keys(codeExit)));
    expect(rows).toEqual([
      { exit: 3, codes: ['lease-held', 'forbidden'] },
      { exit: 4, codes: ['tab-not-found'] },
      { exit: 2, codes: ['flow-invalid'] },
    ]);
    expect(diffTable(codeExit, rows)).toBe(SYNCED);
  });
});
