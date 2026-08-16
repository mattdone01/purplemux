import { agentDisplayName, processMatchesPanelType } from '@/lib/agent-panel-types';
import type { TPanelType } from '@/types/terminal';

const SHELL_NAMES = new Set(['zsh', 'bash', 'fish', 'sh', '-zsh', '-bash', '-fish', '-sh']);

const extractBasename = (path: string): string => {
  if (path === '~' || path === '/') return path;
  const cleaned = path.replace(/\/$/, '');
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || path;
};

export const parseCurrentCommand = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const pipeIdx = trimmed.indexOf('|');
  if (pipeIdx > 0) return trimmed.slice(0, pipeIdx);
  return null;
};

export const isShellProcess = (raw: string): boolean => {
  const cmd = parseCurrentCommand(raw);
  return cmd !== null && SHELL_NAMES.has(cmd);
};

// Codex ships as a bundle and presents as its runtime (`node`), and grok's
// binary is also linked as `agent`, so the tab shows the agent's display name
// instead. Claude's process name is already what the tab has always displayed,
// and is left alone.
const RUNTIME_NAMED_PANEL_TYPES = new Set<TPanelType>(['codex-cli', 'grok-cli']);

const normalizeProcessTitle = (title: string, panelType?: TPanelType): string => (
  panelType && RUNTIME_NAMED_PANEL_TYPES.has(panelType) && processMatchesPanelType(panelType, title)
    ? agentDisplayName(panelType)
    : title
);

export const formatTabTitle = (raw: string, panelType?: TPanelType): string => {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const cmd = parseCurrentCommand(raw);
  if (cmd !== null) {
    const path = trimmed.slice(trimmed.indexOf('|') + 1);
    if (SHELL_NAMES.has(cmd)) return extractBasename(path);
    return normalizeProcessTitle(cmd, panelType);
  }

  // fallback: "user@host: /path" (zsh OSC title)
  const hostPathMatch = trimmed.match(/@[^:]+:\s*(.*)/);
  if (hostPathMatch) {
    return extractBasename(hostPathMatch[1].trim());
  }

  // standalone path
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) {
    return extractBasename(trimmed);
  }

  // command/process name
  const fallbackCmd = trimmed.split(/\s+/)[0];
  if (SHELL_NAMES.has(fallbackCmd)) return '';

  return normalizeProcessTitle(fallbackCmd || '', panelType);
};
