import { randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { NextApiRequest } from 'next';
import { verifyTokenValue } from '@/lib/cli-token';

const TOKENS_FILE = path.join(os.homedir(), '.purplemux', 'workspace-tokens.json');

const g = globalThis as unknown as { __ptWorkspaceTokens?: Record<string, string> };

const readTokens = (): Record<string, string> => {
  if (g.__ptWorkspaceTokens) return g.__ptWorkspaceTokens;
  let parsed: Record<string, string> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
  } catch {
    parsed = {};
  }
  g.__ptWorkspaceTokens = parsed;
  return parsed;
};

const persist = (tokens: Record<string, string>): void => {
  try {
    fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
    const tmp = `${TOKENS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, TOKENS_FILE);
  } catch {
    // in-memory copy still serves this process; a later write may succeed
  }
};

/** Mint-on-demand, stable for the life of the workspace. */
export const getWorkspaceToken = (wsId: string): string => {
  const tokens = readTokens();
  if (tokens[wsId]) return tokens[wsId];
  tokens[wsId] = randomBytes(32).toString('hex');
  persist(tokens);
  return tokens[wsId];
};

export const revokeWorkspaceToken = (wsId: string): void => {
  const tokens = readTokens();
  if (!tokens[wsId]) return;
  delete tokens[wsId];
  persist(tokens);
};

const matches = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export type TCliScope =
  /** The global token: the UI and the user's own shell. Unrestricted. */
  | { type: 'admin' }
  /** A token injected into one workspace's tabs. Confined to that workspace. */
  | { type: 'workspace'; workspaceId: string };

/**
 * Resolve what the caller is allowed to touch. Agents run with a workspace-scoped
 * token injected at tab launch, so an orchestrator naming another workspace is
 * rejected rather than served — isolation is enforced here, not left to the
 * caller passing the right `-w`.
 */
export const resolveCliScope = (req: NextApiRequest): TCliScope | null => {
  const header = req.headers['x-pmux-token'];
  const value = typeof header === 'string' ? header : undefined;
  if (!value) return null;

  if (verifyTokenValue(value)) return { type: 'admin' };

  const tokens = readTokens();
  for (const [wsId, token] of Object.entries(tokens)) {
    if (matches(value, token)) return { type: 'workspace', workspaceId: wsId };
  }
  return null;
};
