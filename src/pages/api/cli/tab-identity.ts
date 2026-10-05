import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, requireMethod } from '@/lib/lease-http';
import { findTabBySessionName } from '@/lib/layout-store';
import { createLogger } from '@/lib/logger';
import { mintHookTabToken } from '@/lib/tab-token';
import { resolveCliScope } from '@/lib/workspace-token';

const log = createLogger('tab-identity');

const SESSION = /^[A-Za-z0-9_.:-]{1,200}$/;

/**
 * Hook-time identity for a tab created before tab tokens (story 36, architect
 * ruling). The Claude SessionStart hook of such a tab presents the pane's own
 * workspace token and its tmux session; a live tab of THAT workspace with that
 * session gets a token it writes to $CLAUDE_ENV_FILE. Mint-only: a tab with a
 * launch token is refused (409), never handed its token. The session is the
 * caller's word, so the token resolves `identity: 'hook'`, never verified.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const scope = resolveCliScope(req, { response: res });
  // The workspace token only: the admin token is not tied to a workspace (a wrong session
  // would hand the agent another workspace's tab), and a tab token already names its tab.
  if (!scope || scope.type !== 'workspace' || scope.tabId) {
    return res.status(403).json({ error: 'the tab identity is requested with the workspace token of the pane', code: 'forbidden' });
  }
  const session = bodyOf(req).session;
  if (typeof session !== 'string' || !SESSION.test(session)) {
    return res.status(400).json({ error: 'session must be a tmux session name', code: 'invalid' });
  }
  const tab = await findTabBySessionName(session, scope.workspaceId).catch(() => null);
  if (!tab) {
    return res.status(404).json({ error: `no tab of ${scope.workspaceId} runs session ${session}`, code: 'tab-not-found' });
  }
  // Only Claude tabs run the SessionStart hook with $CLAUDE_ENV_FILE; every other tab stays `none` (ADR-0010).
  if (tab.panelType !== 'claude-code') {
    return res.status(409).json({ error: `tab ${tab.id} is not a Claude tab; hook-time identity is for Claude tabs only`, code: 'tab-identity-unsupported' });
  }
  const minted = await mintHookTabToken({ workspaceId: scope.workspaceId, tabId: tab.id }, session);
  if (!minted.ok) {
    return minted.reason === 'tab-has-launch-identity'
      ? res.status(409).json({ error: `tab ${tab.id} already has its launch identity`, code: 'tab-has-launch-identity' })
      : res.status(500).json({ error: 'the tab token could not be saved', code: 'tab-token-unsaved' });
  }
  if (minted.minted) log.info({ tabId: tab.id, workspaceId: scope.workspaceId }, 'hook-time tab identity minted');
  return res.status(200).json({ tabId: tab.id, workspaceId: scope.workspaceId, token: minted.token, identity: 'hook' });
};

export default handler;
