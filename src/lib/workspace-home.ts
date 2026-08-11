import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createLogger } from '@/lib/logger';

const log = createLogger('workspace-home');

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const CLAUDE_STATE_FILE = path.join(os.homedir(), '.claude.json');
// Read directly rather than through workspace-store: that module imports tmux,
// and tmux calls in here on every session create, which would close a cycle.
const WORKSPACES_FILE = path.join(os.homedir(), '.purplemux', 'workspaces.json');

// Claude Code keys its session store by cwd (`<config>/projects/<encoded-cwd>/`),
// so two workspaces launched from the same directory share conversation history
// and resume lists. Giving each workspace its own CLAUDE_CONFIG_DIR decouples
// session identity from location, which is what lets several workspaces run from
// one project root.
const workspaceHomeDir = (wsId: string): string =>
  path.join(os.homedir(), '.purplemux', 'workspaces', wsId, 'claude-home');

// Symlinked back to the real ~/.claude: credentials, settings, and the command
// surface must stay common to every workspace. Recreated on each launch so a
// process that replaced a link with a regular file cannot silently fork them.
const SHARED_ENTRIES = [
  '.credentials.json',
  'settings.json',
  'settings.local.json',
  'CLAUDE.md',
  'agents',
  'commands',
  'hooks',
  'rules',
  'plugins',
  'statsig',
];

// Real directories, private to the workspace — the isolation itself.
const PRIVATE_DIRS = ['projects', 'sessions'];

// Decisions worth inheriting from the user's real config. Telemetry (lastCost,
// history, lastAPIDuration) is deliberately left behind.
const INHERITED_PROJECT_KEYS = [
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
  'allowedTools',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
];

const readJson = async (file: string): Promise<Record<string, unknown>> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return {};
  }
};

const writeJsonAtomic = async (file: string, data: unknown): Promise<void> => {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
};

/**
 * Carry the user's own trust and MCP-approval decisions into the workspace's
 * config dir. Without this a fresh CLAUDE_CONFIG_DIR starts untrusted and Claude
 * silently drops every `permissions.allow` entry from project settings.
 *
 * Entries are merged, never overwritten: a directory the workspace already knows
 * about keeps whatever it has learned, and a re-rooted workspace picks up the
 * decision for its new directory on the next launch.
 */
const seedProjectDecisions = async (home: string, directories: string[]): Promise<void> => {
  const target = path.join(home, '.claude.json');
  const current = await readJson(target);
  const source = await readJson(CLAUDE_STATE_FILE);
  const sourceProjects = (source.projects ?? {}) as Record<string, Record<string, unknown>>;
  const projects = (current.projects ?? {}) as Record<string, Record<string, unknown>>;

  let changed = false;
  for (const dir of directories) {
    if (projects[dir]) continue;
    const inherited = sourceProjects[dir] ?? sourceProjects[path.resolve(dir)];
    if (!inherited) continue;
    const carried: Record<string, unknown> = {};
    for (const key of INHERITED_PROJECT_KEYS) {
      if (inherited[key] !== undefined) carried[key] = inherited[key];
    }
    if (Object.keys(carried).length === 0) continue;
    projects[dir] = carried;
    changed = true;
  }

  if (!changed && Object.keys(current).length > 0) return;
  await writeJsonAtomic(target, { ...current, projects });
};

const workspaceDirectories = async (wsId: string): Promise<string[]> => {
  const data = await readJson(WORKSPACES_FILE);
  const workspaces = (data.workspaces ?? []) as Array<{ id: string; directories?: string[] }>;
  return workspaces.find((w) => w.id === wsId)?.directories ?? [];
};

/**
 * Build (or repair) the workspace's private Claude config dir and return its path
 * for CLAUDE_CONFIG_DIR. Idempotent — safe to call on every tab launch.
 */
export const ensureWorkspaceClaudeHome = async (wsId: string): Promise<string> => {
  const directories = await workspaceDirectories(wsId);
  const home = workspaceHomeDir(wsId);
  await fs.mkdir(home, { recursive: true });
  await Promise.all(PRIVATE_DIRS.map((d) => fs.mkdir(path.join(home, d), { recursive: true })));

  await Promise.all(
    SHARED_ENTRIES.map(async (entry) => {
      const source = path.join(CLAUDE_HOME, entry);
      if (!(await fs.access(source).then(() => true).catch(() => false))) return;
      const link = path.join(home, entry);
      try {
        await fs.rm(link, { recursive: true, force: true });
        await fs.symlink(source, link);
      } catch (err) {
        log.warn(`could not link ${entry} into ${wsId}'s claude home: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );

  await seedProjectDecisions(home, directories);
  return home;
};

export const removeWorkspaceClaudeHome = async (wsId: string): Promise<void> => {
  await fs.rm(path.join(os.homedir(), '.purplemux', 'workspaces', wsId, 'claude-home'), {
    recursive: true,
    force: true,
  });
};
