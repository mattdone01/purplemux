import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createLogger } from '@/lib/logger';
import { GROK_HOME, GROK_HOOKS_DIRNAME, GROK_SESSIONS_DIRNAME } from '@/lib/providers/grok/paths';

const log = createLogger('grok-home');

const WORKSPACES_DIR = path.join(os.homedir(), '.purplemux', 'workspaces');

/**
 * Grok Build keys its session store by working directory
 * (`$GROK_HOME/sessions/<encoded-cwd>/`), so two workspaces launched from the
 * same project would share history and `--continue` lists. `GROK_HOME` is the
 * documented override (`05-configuration.md`, "Paths"), and it is the exact
 * counterpart of `CLAUDE_CONFIG_DIR` in `workspace-home.ts`.
 */
export const workspaceGrokHomeDir = (wsId: string): string =>
  path.join(WORKSPACES_DIR, wsId, 'grok-home');

/**
 * Real directories, private to the workspace — the isolation itself. Everything
 * else grok writes at the top of `$GROK_HOME` (`active_sessions.json`,
 * `worktrees/`, `downloads/`) is created by grok and is private for free.
 */
const PRIVATE_DIRS = [GROK_SESSIONS_DIRNAME, GROK_HOOKS_DIRNAME, 'logs'];

/**
 * Symlinked back to the real `~/.grok`: credentials, configuration and the
 * skill/command surface must stay common to every workspace, or a workspace tab
 * would ask the user to log in again and would not see their own skills.
 *
 * Taken from the file table in `~/.grok/docs/user-guide/05-configuration.md`
 * plus `trusted_folders.toml` (10-hooks.md, folder trust) and
 * `mcp_credentials.json` (07-mcp-servers.md). An entry that does not exist in
 * `~/.grok` is skipped, so an install without MCP or LSP links nothing for them.
 */
const SHARED_ENTRIES = [
  'auth.json',
  'config.toml',
  'managed_config.toml',
  'requirements.toml',
  'pager.toml',
  'lsp.json',
  'trusted_folders.toml',
  'mcp_credentials.json',
  'skills',
  'commands',
  'rules',
  'memory',
  'agents',
  'plugins',
  'workflows',
];

export const grokSharedEntries = (): readonly string[] => SHARED_ENTRIES;
export const grokPrivateDirs = (): readonly string[] => PRIVATE_DIRS;

const exists = async (target: string): Promise<boolean> =>
  fs.access(target).then(() => true).catch(() => false);

/**
 * Points one shared entry at its counterpart in the real `~/.grok`.
 *
 * A shared entry is only linked once `~/.grok` has it, so grok running under
 * the workspace home can have created a REAL file or directory there first —
 * `memory/` with the workspace's own notes in it, for example. Only an absent
 * path or an existing symlink is replaced; anything real is left where it is
 * and reported, because the alternative is deleting data purplemux never wrote.
 */
const linkSharedEntry = async (home: string, wsId: string, entry: string): Promise<void> => {
  const source = path.join(GROK_HOME, entry);
  if (!(await exists(source))) return;

  const link = path.join(home, entry);
  const current = await fs.lstat(link).catch(() => null);
  if (current && !current.isSymbolicLink()) {
    log.warn(
      `${entry} in ${wsId}'s grok home is a real ${current.isDirectory() ? 'directory' : 'file'}; `
      + `leaving it in place instead of linking it to ${source}`,
    );
    return;
  }

  try {
    if (current) await fs.rm(link, { force: true });
    await fs.symlink(source, link);
  } catch (err) {
    log.warn(`could not link ${entry} into ${wsId}'s grok home: ${err instanceof Error ? err.message : err}`);
  }
};

/**
 * Build (or repair) the workspace's private grok home and return its path for
 * `GROK_HOME`. Idempotent — safe to call on every pane launch. A link that
 * stopped naming its shared entry is repointed on the next launch.
 */
export const ensureWorkspaceGrokHome = async (wsId: string): Promise<string> => {
  const home = workspaceGrokHomeDir(wsId);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await Promise.all(PRIVATE_DIRS.map((dir) => fs.mkdir(path.join(home, dir), { recursive: true, mode: 0o700 })));
  await Promise.all(SHARED_ENTRIES.map((entry) => linkSharedEntry(home, wsId, entry)));

  return home;
};

/** Every workspace grok home that exists on disk. */
export const listWorkspaceGrokHomes = async (): Promise<string[]> => {
  let entries;
  try {
    entries = await fs.readdir(WORKSPACES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const homes = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const home = path.join(WORKSPACES_DIR, entry.name, 'grok-home');
        return (await exists(home)) ? home : null;
      }),
  );
  return homes.filter((home): home is string => home !== null);
};

/**
 * The unscoped home first, then one per workspace. Ad-hoc tabs run against
 * `~/.grok`, so a scan that skipped it would miss their sessions entirely.
 */
export const listGrokHomes = async (): Promise<string[]> => [
  GROK_HOME,
  ...(await listWorkspaceGrokHomes()),
];

/** The workspace a grok home belongs to; null for the unscoped `~/.grok`. */
export const workspaceIdForGrokHome = (home: string): string | null => {
  const resolved = path.resolve(home);
  if (resolved === path.resolve(GROK_HOME)) return null;
  const parent = path.dirname(resolved);
  return path.dirname(parent) === path.resolve(WORKSPACES_DIR) ? path.basename(parent) : null;
};

export const removeWorkspaceGrokHome = async (wsId: string): Promise<void> => {
  await fs.rm(workspaceGrokHomeDir(wsId), { recursive: true, force: true });
};
