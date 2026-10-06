import { randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyTokenValue } from '@/lib/cli-token';
import { notePresented, resolveTabToken, tokenOrigin } from '@/lib/tab-token';

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
  /** Global CLI read authority; not human identity or workspace mutation authority. */
  | { type: 'admin' }
  /**
   * A token injected into one workspace's tabs. Confined to that workspace.
   * A per-tab token (ADR-0010) resolves to the same scope and additionally
   * names its tab for verified read grants and caller attribution.
   */
  | { type: 'workspace'; workspaceId: string; tabId?: string; tabVerified?: true; tabIdentity?: 'launch' | 'hook' };

/**
 * Resolve what the caller is allowed to touch. Agents run with a workspace-scoped
 * token injected at tab launch, so an orchestrator naming another workspace is
 * rejected rather than served — isolation is enforced here, not left to the
 * caller passing the right `-w`.
 */
export const resolveCliScope = (req: NextApiRequest, opts: { response?: NextApiResponse } = {}): TCliScope | null => {
  const header = req.headers['x-pmux-token'];
  const value = typeof header === 'string' ? header : undefined;
  if (!value) return null;

  if (verifyTokenValue(value)) return { type: 'admin' };

  const tokens = readTokens();
  for (const [wsId, token] of Object.entries(tokens)) {
    if (matches(value, token)) return { type: 'workspace', workspaceId: wsId };
  }

  const tab = resolveTabToken(value);
  if (!tab) return null;
  // Only a token the server bound at session creation is proof; a hook-time token names the tab (story 36).
  // Scope resolution never records presentation before a completed successful route.
  const response = opts.response as (NextApiResponse & { [key: symbol]: boolean | undefined }) | undefined;
  const scheduled = Symbol.for('purplemux.cli-presentation-scheduled');
  if (response && tokenOrigin(tab.record) === 'hook' && !response[scheduled]) {
    response[scheduled] = true;
    response.once?.('finish', () => {
      if (response.statusCode >= 200 && response.statusCode < 400) notePresented(tab.tabId, tab.record);
    });
  }
  return tokenOrigin(tab.record) === 'launch'
    ? { type: 'workspace', workspaceId: tab.record.workspaceId, tabId: tab.tabId, tabVerified: true, tabIdentity: 'launch' }
    : { type: 'workspace', workspaceId: tab.record.workspaceId, tabId: tab.tabId, tabIdentity: 'hook' };
};
