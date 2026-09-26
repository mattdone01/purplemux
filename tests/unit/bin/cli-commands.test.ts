import { execFile } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ENTRY = path.resolve('bin/purplemux.js');
const CLI_SOURCE = fs.readFileSync(path.resolve('bin/cli.js'), 'utf-8');
const requireCjs = createRequire(import.meta.url);
const { CLI_COMMANDS } = requireCjs(path.resolve('bin/cli-commands.js')) as { CLI_COMMANDS: Set<string> };

/**
 * The `case '<name>'` labels of the top-level switch in `main()` — the command
 * groups. Nested switches (`tab list`, `workspace dirs`) sit one indent deeper
 * and are not command groups.
 */
const topLevelCases = (): string[] => {
  const main = CLI_SOURCE.slice(CLI_SOURCE.indexOf('const main = async'));
  const body = main.slice(0, main.indexOf('\n};\n'));
  const outer = /^ {4}case '([^']+)':/gm;
  return [...body.matchAll(outer)].map((m) => m[1]);
};

describe('bin/cli-commands.js — the set the installed entry point dispatches on', () => {
  it('finds the command groups in cli.js main()', () => {
    const cases = topLevelCases();
    expect(cases).toContain('tab');
    expect(cases).toContain('api-guide');
    expect(cases).not.toContain('send');
  });

  it('registers every top-level case of cli.js main()', () => {
    const missing = topLevelCases().filter((name) => !CLI_COMMANDS.has(name));
    expect(missing).toEqual([]);
  });

  it('registers nothing cli.js does not handle', () => {
    const cases = new Set(topLevelCases());
    const extra = [...CLI_COMMANDS].filter((name) => !cases.has(name));
    expect(extra).toEqual([]);
  });

  it('is the set bin/purplemux.js reads', () => {
    const entry = fs.readFileSync(ENTRY, 'utf-8');
    expect(entry).toContain("require('./cli-commands.js')");
    expect(entry).not.toMatch(/new Set\(\[/);
  });

  it.each(topLevelCases())('node bin/purplemux.js %s help reaches the CLI', async (name) => {
    const result = await run(process.execPath, [ENTRY, name, 'help'], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: '/nonexistent', NO_UPDATE_NOTIFIER: '1', PMUX_PORT: '1', PMUX_TOKEN: 't' },
    }).catch((error: { stderr: string; stdout: string }) => error);
    expect(result.stderr).not.toContain(`unknown command: ${name}`);
  });
});
