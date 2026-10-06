import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { findTab } from '@/lib/cli-utils';
import { getStatusManager } from '@/lib/status-manager';
import { parseSendRequest, performTabSend, resolveTabCliState } from '@/lib/tab-send';
import { hasSession, isContentPendingInComposer } from '@/lib/tmux';
import { deliverPrompt, deliverPromptText } from '@/lib/agent-prompt-delivery';

/**
 * Cookie-authed twin of `POST /api/cli/tabs/[tabId]/send`, for clients that
 * hold a `session-token` cookie instead of the CLI token — the phone must never
 * carry a token that also authorises `purplemux tab send` into every workspace.
 *
 * The handler authenticates a human cookie and same-origin request. Global and
 * workspace CLI tokens do not authorize this route; agents use the scoped CLI route.
 *
 * On the `live-session` gate, so a phone can reach a `busy` agent exactly as
 * the web client does. The two routes differ in readiness on purpose — see
 * `TSendGate` in `@/lib/tab-send`.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = parseSendRequest(req.query, req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const result = await performTabSend(
    {
      findTarget: async (workspaceId, tabId) => {
        const found = await findTab(workspaceId, tabId);
        if (!found) return null;
        return {
          sessionName: found.tab.sessionName,
          panelType: found.tab.panelType,
          cliState: resolveTabCliState(found.tab, getStatusManager().getAllForClient()[tabId]),
        };
      },
      hasSession,
      paste: deliverPrompt,
      pasteWithoutSubmit: deliverPromptText,
      isContentPendingInComposer,
    },
    parsed.request,
  );

  return res.status(result.status).json(result.body);
};

export default handler;
