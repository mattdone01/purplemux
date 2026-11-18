import { accessSync, constants as fsConstants } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { GH_COMMAND_WORDS, GH_PLAIN_COMMANDS } from '@/lib/github-usage-ledger';
import { LOGIN_SHELL_BASE_PATH } from '@/lib/shell-env';

// The gh shim (engineering#810, R1 (a)): a local tab's `gh` writes one line to the gh-calls log, then runs the real
// gh. The line holds the time, the tab, the workspace and two words of an allow-list, never a path, a query or a
// token. A tab's login rc can put the real gh's directory before the shim (measured: ~/.local/bin), so every local
// agent launch also starts through `pmux-gh-path`, which puts the shim first again after the rc (consult ruling B).

export const ghShimDir = (home: string = os.homedir()): string => path.join(home, '.local', 'share', 'purplemux', 'bin');
export const ghShimPath = (home: string = os.homedir()): string => path.join(ghShimDir(home), 'gh');
export const ghPathExecPath = (home: string = os.homedir()): string => path.join(ghShimDir(home), 'pmux-gh-path');

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const ID_FROM_ENV = (name: string, variable: string): string[] => [
  `  ${variable}=-`,
  `  case "\${${name}-}" in ''|*[!A-Za-z0-9_-]*) ;; *) ${variable}=$${name} ;; esac`,
];

const commandCases = (): string[] => [
  ...Object.entries(GH_COMMAND_WORDS).map(([cmd, subs]) =>
    `    ${cmd}) c=${cmd}; if [ $# -lt 2 ]; then s=-; else case "$2" in ${subs.join('|')}) s=$2 ;; esac; fi ;;`),
  `    ${GH_PLAIN_COMMANDS.join('|')}) c=$1; [ $# -lt 2 ] && s=- ;;`,
];

/** The shim: a POSIX sh script with the real gh pinned by its absolute path. */
export const ghShimScript = (realGh: string): string => [
  '#!/bin/sh',
  '# purplemux gh shim (engineering#810): one line per call to the gh-calls log, then the real gh.',
  '# An api call records its kind only; any word outside the allow-list is "?". A failed write never stops the call.',
  `real=${shQuote(realGh)}`,
  '(',
  '  umask 077',
  '  d="${XDG_STATE_HOME:-$HOME/.local/state}/purplemux/gh-calls"',
  ...ID_FROM_ENV('PMUX_TAB_ID', 't'),
  ...ID_FROM_ENV('PMUX_WORKSPACE_ID', 'w'),
  "  c='?'; s='?'",
  '  case "${1-}" in',
  '    api) c=api; s=rest; for a in "$@"; do [ "$a" = graphql ] && s=graphql; done ;;',
  ...commandCases(),
  '  esac',
  '  mkdir -p "$d" && printf \'%s %s %s %s %s\\n\' "$(date +%s)" "$t" "$w" "$c" "$s" >>"$d/$(date -u +%Y%m%d).log"',
  ') 2>/dev/null',
  'exec "$real" "$@"',
  '',
].join('\n');

/** The launch wrapper: the shim directory first on PATH, then the command. */
export const ghPathExecScript = (dir: string): string => [
  '#!/bin/sh',
  '# purplemux (engineering#810): run a local agent with the gh shim first on PATH, after the shell rc.',
  `PATH=${shQuote(dir)}:"$PATH"`,
  'export PATH',
  'exec "$@"',
  '',
].join('\n');

const isExecutableFile = async (file: string): Promise<boolean> => {
  try {
    if (!(await fs.stat(file)).isFile()) return false;
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const realpathOrNull = async (file: string): Promise<string | null> => fs.realpath(file).catch(() => null);

/**
 * The first executable `gh` on `pathEnv` that is not the shim: the shim directory is skipped, and so is any entry
 * that resolves to the shim (a link to it). Relative entries are skipped: the pin must not depend on a cwd.
 */
export const resolveRealGh = async (pathEnv: string, shimDir: string): Promise<string | null> => {
  const shimDirReal = await realpathOrNull(shimDir);
  const shimReal = await realpathOrNull(path.join(shimDir, 'gh'));
  for (const entry of pathEnv.split(':')) {
    if (!entry || !path.isAbsolute(entry) || path.resolve(entry) === path.resolve(shimDir)) continue;
    if (shimDirReal && (await realpathOrNull(entry)) === shimDirReal) continue;
    const candidate = path.join(entry, 'gh');
    if (!(await isExecutableFile(candidate))) continue;
    const real = await realpathOrNull(candidate);
    if (real && (real === shimReal || path.dirname(real) === shimDirReal)) continue;
    return candidate;
  }
  return null;
};

export type TGhShimInstall = { installed: true; dir: string; realGh: string } | { installed: false; reason: string };

const writeExecutable = async (file: string, content: string): Promise<void> => {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o755 });
  await fs.chmod(tmp, 0o755);
  await fs.rename(tmp, file);
};

/**
 * Write the shim and the launch wrapper (0755) in a 0700 directory, with the real gh resolved once from PATH. With
 * no real gh, nothing is installed and an earlier shim is removed, so no tab PATH changes.
 */
export const installGhShim = async (opts: { home?: string; pathEnv?: string } = {}): Promise<TGhShimInstall> => {
  const home = opts.home ?? os.homedir();
  const dir = ghShimDir(home);
  const realGh = await resolveRealGh(opts.pathEnv ?? process.env.PATH ?? '', dir);
  if (!realGh) {
    await Promise.all([ghShimPath(home), ghPathExecPath(home)].map((file) => fs.rm(file, { force: true })));
    return { installed: false, reason: 'no gh on PATH outside the shim directory' };
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await writeExecutable(ghPathExecPath(home), ghPathExecScript(dir));
  await writeExecutable(ghShimPath(home), ghShimScript(realGh));
  return { installed: true, dir, realGh };
};

/** The shim directory when both scripts are installed and executable; null otherwise. */
export const installedGhShimDir = (home: string = os.homedir()): string | null => {
  try {
    accessSync(ghShimPath(home), fsConstants.X_OK);
    accessSync(ghPathExecPath(home), fsConstants.X_OK);
    return ghShimDir(home);
  } catch {
    return null;
  }
};

/** A local pane's PATH: the shim directory, then the login floor the shell builds on (never the server PATH). */
export const ghShimPaneEnv = (home: string = os.homedir()): Record<string, string> => {
  const dir = installedGhShimDir(home);
  return dir ? { PATH: `${dir}:${LOGIN_SHELL_BASE_PATH}` } : {};
};

/** What a local agent launch starts with: the quoted wrapper and a space, or nothing without a shim. */
export const ghShimLaunchPrefix = (home: string = os.homedir()): string =>
  installedGhShimDir(home) ? `${shQuote(ghPathExecPath(home))} ` : '';

/** `pathEnv` without the shim directory: the server's own gh calls are counted by its ledger, not by the shim. */
export const withoutGhShimDir = (pathEnv: string, home: string = os.homedir()): string =>
  pathEnv.split(':').filter((entry) => !entry || path.resolve(entry) !== ghShimDir(home)).join(':');
