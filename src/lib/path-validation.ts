import path from 'path';
import os from 'os';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const WORKSPACES_DIR = path.join(os.homedir(), '.purplemux', 'workspaces');
const CLAUDE_HOME_PROJECTS_SEGMENT = path.sep + path.join('claude-home', 'projects') + path.sep;
const GROK_SESSIONS_DIR = path.join(os.homedir(), '.grok', 'sessions');
const GROK_HOME_SESSIONS_SEGMENT = path.sep + path.join('grok-home', 'sessions') + path.sep;

// Workspace panes run claude with CLAUDE_CONFIG_DIR under
// ~/.purplemux/workspaces/<id>/claude-home, so their transcripts live there
// rather than in ~/.claude/projects.
const isWorkspaceClaudeJsonlPath = (resolved: string): boolean =>
  resolved.startsWith(WORKSPACES_DIR + path.sep) &&
  resolved.includes(CLAUDE_HOME_PROJECTS_SEGMENT);

// A workspace pane runs grok with GROK_HOME under
// ~/.purplemux/workspaces/<id>/grok-home, so its transcripts live there rather
// than in ~/.grok/sessions.
const isWorkspaceGrokJsonlPath = (resolved: string): boolean =>
  resolved.startsWith(WORKSPACES_DIR + path.sep) &&
  resolved.includes(GROK_HOME_SESSIONS_SEGMENT);

export const isGrokJsonlPath = (filePath: string): boolean => {
  const resolved = path.resolve(filePath);
  if (path.basename(resolved) !== 'updates.jsonl') return false;
  return resolved.startsWith(GROK_SESSIONS_DIR + path.sep) || isWorkspaceGrokJsonlPath(resolved);
};

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
    isWorkspaceClaudeJsonlPath(resolved) ||
    resolved.startsWith(GROK_SESSIONS_DIR + path.sep) ||
    isWorkspaceGrokJsonlPath(resolved)
  );
};
