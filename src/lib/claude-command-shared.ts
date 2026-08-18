// Browser-safe subset of claude-command.ts (which imports node-only modules).
const MODEL_RE = /^[A-Za-z0-9._-]+$/;

export const isValidModelName = (model: unknown): model is string =>
  typeof model === 'string' && MODEL_RE.test(model);

// Without an explicit --effort a session inherits the user's global
// effortLevel — which makes every spawned worker as expensive as the human's
// own default. Orchestrators pin effort at tab creation instead.
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const isValidClaudeEffort = (effort: unknown): effort is (typeof CLAUDE_EFFORT_LEVELS)[number] =>
  typeof effort === 'string' && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(effort);
