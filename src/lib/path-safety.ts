// Shared directory rules for POST /api/workspace (opt-in mkdir) and
// GET /api/workspace/validate, so both answer the same question the same way.
//
// `~` is NOT expanded here. The client expands it before it reaches the server,
// so a path that still starts with `~` is a literal directory named `~`.
import path from 'path';

export type TDirectoryStat = 'directory' | 'file' | 'missing';

export interface IDirectoryValidation {
  valid: boolean;
  error?: string;
  suggestedName?: string;
  exists: boolean;
  isDirectory: boolean;
  canCreate: boolean;
}

export type TDirectoryPlan =
  | { action: 'use' }
  | { action: 'create' }
  | { action: 'reject'; error: string };

export const DIRECTORY_MISSING_ERROR = 'Directory does not exist';
export const NOT_A_DIRECTORY_ERROR = 'Please enter a directory path, not a file';
export const OUTSIDE_HOME_ERROR = 'Directory does not exist and cannot be created outside your home directory';

export const DIRECTORY_ERROR_CODE = 'INVALID_WORKSPACE_DIRECTORY';

export const directoryError = (message: string): Error =>
  Object.assign(new Error(message), { code: DIRECTORY_ERROR_CODE });

// Duck-typed rather than `instanceof`: server.ts and the API routes hold separate
// module graphs (CLAUDE.md §18), so an Error class can exist twice in one process.
export const isDirectoryError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === DIRECTORY_ERROR_CODE;

/**
 * Whether the server may `mkdir -p` this path. The rule is a fat-finger boundary,
 * not an authorization one: the target must be an absolute, `..`-free path that
 * resolves inside the user's home, so a typo on a phone cannot write outside $HOME.
 * The caller is already cookie-authed as the single purplemux user and can open a
 * terminal tab, so this never had an attacker to stop.
 *
 * Every ancestor of an in-home target is itself in home or is home, so checking the
 * target alone also answers "is the nearest existing ancestor inside home".
 *
 * Containment is **lexical, deliberately** — the filesystem is never consulted, so a
 * symlinked ancestor escapes it: with `~/projects -> /mnt/big/projects`, creating
 * `~/projects/newthing` is accepted and lands outside $HOME. Resolving symlinks would
 * refuse that ordinary setup, and would make this helper fs-dependent, letting the
 * create and validate paths disagree whenever the filesystem changes between the two
 * calls. Exploiting the gap needs a hostile symlink already inside the user's home —
 * write access the endpoint would not be granting. Pinned by
 * tests/unit/lib/workspace-create-directory.test.ts; change it knowingly or not at all.
 */
export const canCreateDirectory = (target: string, home: string): boolean => {
  if (typeof target !== 'string' || typeof home !== 'string') return false;
  if (!target.trim() || !home.trim()) return false;
  if (!path.isAbsolute(target) || !path.isAbsolute(home)) return false;
  if (target.split(path.sep).includes('..')) return false;

  const resolvedHome = path.resolve(home);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedHome || resolvedTarget.startsWith(resolvedHome + path.sep);
};

export const buildDirectoryValidation = (input: {
  directory: string;
  home: string;
  stat: TDirectoryStat;
}): IDirectoryValidation => {
  const { directory, home, stat } = input;

  if (stat === 'file') {
    return { valid: false, error: NOT_A_DIRECTORY_ERROR, exists: true, isDirectory: false, canCreate: false };
  }

  const canCreate = canCreateDirectory(directory, home);

  if (stat === 'missing') {
    return { valid: false, error: DIRECTORY_MISSING_ERROR, exists: false, isDirectory: false, canCreate };
  }

  return { valid: true, suggestedName: path.basename(directory), exists: true, isDirectory: true, canCreate };
};

export const planDirectoryCreate = (input: {
  directory: string;
  home: string;
  stat: TDirectoryStat;
  mkdir: boolean;
}): TDirectoryPlan => {
  const { directory, home, stat, mkdir } = input;

  if (stat === 'file') return { action: 'reject', error: NOT_A_DIRECTORY_ERROR };
  if (stat === 'directory') return { action: 'use' };
  if (!mkdir) return { action: 'reject', error: DIRECTORY_MISSING_ERROR };

  return canCreateDirectory(directory, home)
    ? { action: 'create' }
    : { action: 'reject', error: OUTSIDE_HOME_ERROR };
};
