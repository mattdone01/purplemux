import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// A whole-project trace put server.ts into .next/standalone, and tsx loaded that
// copy in place of standalone/server.js: the release built, then never started.
// The build must refuse such a tree (scripts/post-build.js).

interface ICheck {
  ROOT_ONLY_FILES: string[];
  wholeProjectTraceMarkers: (dir: string) => string[];
  describeWholeProjectTrace: (dir: string) => string | null;
}

const SCRIPTS = path.resolve(__dirname, '../../../scripts');
const check = createRequire(__filename)(path.join(SCRIPTS, 'standalone-trace-check.cjs')) as ICheck;

// The top level of d1fd69bd's standalone tree, which starts.
const CLEAN = ['.next', 'messages', 'package.json', 'public', 'server.js', 'src'];
// A top-level sample of 8cf238e2's standalone tree, which does not.
const WHOLE = [...CLEAN, 'server.ts', 'next.config.ts', 'tsconfig.json', 'pnpm-lock.yaml', 'Makefile', 'scripts'];

const layOut = (dir: string, entries: string[]) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of entries) {
    if (name.includes('.') && !name.startsWith('.')) fs.writeFileSync(path.join(dir, name), '');
    else fs.mkdirSync(path.join(dir, name), { recursive: true });
  }
};

describe('standalone whole-project trace check', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmx-standalone-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('passes the tree of a release that starts', () => {
    layOut(tmp, CLEAN);
    expect(check.wholeProjectTraceMarkers(tmp)).toEqual([]);
    expect(check.describeWholeProjectTrace(tmp)).toBeNull();
  });

  it('names every root-only file and the whole top level of a traced-project tree', () => {
    layOut(tmp, WHOLE);
    expect(check.wholeProjectTraceMarkers(tmp)).toEqual(['server.ts', 'next.config.ts', 'tsconfig.json', 'pnpm-lock.yaml']);
    const text = check.describeWholeProjectTrace(tmp) ?? '';
    expect(text).toContain('REFUSED WHOLE-PROJECT-TRACE');
    expect(text).toContain('measured: root-only files ["server.ts","next.config.ts","tsconfig.json","pnpm-lock.yaml"]; 12 top-level entries');
    expect(text).toContain(`expected: none of ${JSON.stringify(check.ROOT_ONLY_FILES)}`);
  });

  it('server.ts alone is enough: it is the copy tsx would load in place of server.js', () => {
    layOut(tmp, [...CLEAN, 'server.ts']);
    expect(check.wholeProjectTraceMarkers(tmp)).toEqual(['server.ts']);
  });

  describe('scripts/post-build.js', () => {
    const runPostBuild = (standaloneEntries: string[]) => {
      const root = path.join(tmp, 'root');
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      for (const f of ['post-build.js', 'standalone-trace-check.cjs']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f));
      layOut(path.join(root, '.next', 'standalone'), standaloneEntries);
      return spawnSync(process.execPath, [path.join(root, 'scripts', 'post-build.js')], { encoding: 'utf-8', timeout: 30_000 });
    };

    it('refuses a whole-project trace before it touches the tree', () => {
      const r = runPostBuild(WHOLE);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('REFUSED WHOLE-PROJECT-TRACE');
      expect(r.stdout).not.toContain('public →');
    });

    it('completes on a clean tree', () => {
      const r = runPostBuild(CLEAN);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).not.toContain('REFUSED');
    });
  });
});
