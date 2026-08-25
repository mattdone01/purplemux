import { CLAUDE_EFFORT_LEVELS, isValidClaudeEffort } from '@/lib/claude-command-shared';
import type { TPanelType } from '@/types/terminal';

export { CLAUDE_EFFORT_LEVELS, isValidClaudeEffort };

/** Codex `model_reasoning_effort` values. */
export const CODEX_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

export const isValidCodexEffort = (effort: unknown): effort is (typeof CODEX_EFFORT_LEVELS)[number] =>
  typeof effort === 'string' && (CODEX_EFFORT_LEVELS as readonly string[]).includes(effort);

/**
 * Grok Build `--effort` / `--reasoning-effort` values (`14-headless-mode.md`).
 * Wider than Codex; includes Claude's xhigh/max plus none/minimal.
 */
export const GROK_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const isValidGrokEffort = (effort: unknown): effort is (typeof GROK_EFFORT_LEVELS)[number] =>
  typeof effort === 'string' && (GROK_EFFORT_LEVELS as readonly string[]).includes(effort);

export const reasoningErrorForPanelType = (panelType: TPanelType): string => {
  if (panelType === 'claude-code') return 'Invalid reasoning for claude-code (low|medium|high|xhigh|max)';
  if (panelType === 'grok-cli') return 'Invalid reasoning for grok-cli (none|minimal|low|medium|high|xhigh|max)';
  return 'Invalid reasoning for codex-cli (minimal|low|medium|high)';
};

/** Validate `-r` against the engine the tab will actually launch. */
export const isValidReasoningForPanelType = (panelType: TPanelType, effort: unknown): boolean => {
  if (panelType === 'claude-code') return isValidClaudeEffort(effort);
  if (panelType === 'grok-cli') return isValidGrokEffort(effort);
  return isValidCodexEffort(effort);
};
