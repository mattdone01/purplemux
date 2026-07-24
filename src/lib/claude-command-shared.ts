// Browser-safe subset of claude-command.ts (which imports node-only modules).
const MODEL_RE = /^[A-Za-z0-9._-]+$/;

export const isValidModelName = (model: unknown): model is string =>
  typeof model === 'string' && MODEL_RE.test(model);
