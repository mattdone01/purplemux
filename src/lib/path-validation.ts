import path from 'path';
import os from 'os';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const WORKSPACES_DIR = path.join(os.homedir(), '.purplemux', 'workspaces');
const CLAUDE_HOME_PROJECTS_SEGMENT = path.sep + path.join('claude-home', 'projects') + path.sep;

// Workspace panes run claude with CLAUDE_CONFIG_DIR under
// ~/.purplemux/workspaces/<id>/claude-home, so their transcripts live there
// rather than in ~/.claude/projects.
const isWorkspaceClaudeJsonlPath = (resolved: string): boolean =>
  resolved.startsWith(WORKSPACES_DIR + path.sep) &&
  resolved.includes(CLAUDE_HOME_PROJECTS_SEGMENT);

export const isCodexJsonlPath = (filePath: string): boolean => {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(CODEX_SESSIONS_DIR + path.sep) && resolved.endsWith('.jsonl');
};

export const isAllowedJsonlPath = (filePath: string): boolean => {
  const resolved = path.resolve(filePath);
  if (!resolved.endsWith('.jsonl')) return false;
  return (
    resolved.startsWith(CLAUDE_PROJECTS_DIR + path.sep) ||
    resolved.startsWith(CODEX_SESSIONS_DIR + path.sep) ||
    isWorkspaceClaudeJsonlPath(resolved)
  );
};
