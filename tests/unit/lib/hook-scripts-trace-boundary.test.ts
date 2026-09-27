import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Next routes import src/lib/hook-scripts.ts (through hook-settings.ts), so
// Turbopack traces its file operations. installHookScripts builds
// `path.join(dir, name)` from an argument, which Turbopack cannot scope to a
// folder: with it in hook-scripts.ts (8cf238e2), the build traced the whole
// project into .next/standalone, a copy of server.ts landed beside server.js,
// and the release never started. The installer lives in hook-scripts-install.ts,
// which only scripts/ and tests/ import.

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(ROOT, 'src');

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });

describe('hook script installer stays out of the Next trace', () => {
  it('no module under src/ imports the directory installer', () => {
    const importers = sourceFiles(SRC)
      .filter((file) => /['"]@\/lib\/hook-scripts-install['"]|['"]\.\/hook-scripts-install['"]/.test(fs.readFileSync(file, 'utf-8')))
      .map((file) => path.relative(ROOT, file));
    expect(importers).toEqual([]);
  });

  it('hook-scripts.ts, which routes import, builds no path from an argument', () => {
    const code = fs
      .readFileSync(path.join(SRC, 'lib', 'hook-scripts.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bpath\.(join|resolve)\(/);
    expect(code).not.toMatch(/export const installHookScripts\b/);
  });

  it('the install script takes the installer from the untraced module', () => {
    const text = fs.readFileSync(path.join(ROOT, 'scripts', 'install-hook-scripts.ts'), 'utf-8');
    expect(text).toContain("from '@/lib/hook-scripts-install'");
  });
});
