import os from 'os';
import path from 'path';

/**
 * Grok Build's own home. `GROK_HOME` overrides it (05-configuration.md
 * "Paths"), which is what gives purplemux a per-workspace store; this constant
 * is the unscoped one every ad-hoc tab uses.
 */
export const GROK_HOME = path.join(os.homedir(), '.grok');

/** The install script drops the binary here and does not always touch PATH. */
export const GROK_BIN_DIR = path.join(GROK_HOME, 'bin');
export const GROK_BIN_PATH = path.join(GROK_BIN_DIR, 'grok');

/** Auth is NOT per-home: every workspace store symlinks back to this file. */
export const GROK_AUTH_PATH = path.join(GROK_HOME, 'auth.json');

export const GROK_SESSIONS_DIRNAME = 'sessions';
export const GROK_HOOKS_DIRNAME = 'hooks';

/** One `updates.jsonl` per session directory — the authoritative ACP log. */
export const GROK_UPDATES_FILENAME = 'updates.jsonl';
export const GROK_SUMMARY_FILENAME = 'summary.json';
export const GROK_SIGNALS_FILENAME = 'signals.json';

/**
 * Grok names a session group after the URL-encoded working directory, and falls
 * back to a slug plus a hash with the real path in a `.cwd` file when the
 * encoded name would exceed 255 bytes (17-sessions.md "Storage Layout").
 * purplemux never reconstructs that name: it reads the group's own record of
 * its cwd instead, so a change to the encoding cannot silently unbind a tab.
 */
export const GROK_CWD_MARKER_FILENAME = '.cwd';

export const grokSessionsRoot = (home: string): string => path.join(home, GROK_SESSIONS_DIRNAME);

export const grokHooksDir = (home: string): string => path.join(home, GROK_HOOKS_DIRNAME);

export const grokUpdatesPath = (sessionDir: string): string =>
  path.join(sessionDir, GROK_UPDATES_FILENAME);

/** Every path under a session directory resolves back to its session id. */
export const grokSessionIdFromJsonlPath = (jsonlPath: string | null | undefined): string | null => {
  if (!jsonlPath) return null;
  const dir = path.basename(path.dirname(jsonlPath));
  return dir && dir !== '.' && dir !== path.sep ? dir : null;
};

/**
 * The hook script purplemux generates and every `$GROK_HOME/hooks/purplemux.json`
 * points at. It lives here rather than in `hook-settings.ts` so the hook writer
 * and the pane-launch path can both reach it without a module cycle.
 */
export const GROK_HOOK_SCRIPT_PATH = path.join(os.homedir(), '.purplemux', 'grok-hook.sh');

/**
 * The `$GROK_HOME` a transcript belongs to, from
 * `<home>/sessions/<group>/<session-id>/updates.jsonl`. It is the workspace
 * segment of the session key, so it is read from the path rather than guessed.
 */
export const grokHomeFromJsonlPath = (jsonlPath: string): string =>
  path.resolve(jsonlPath, '..', '..', '..', '..');
