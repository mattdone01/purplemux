import type { NextApiRequest, NextApiResponse } from 'next';
import { findTab } from '@/lib/cli-utils';
import { getStatusManager } from '@/lib/status-manager';
import { parseSendRequest, performTabSend, resolveTabCliState } from '@/lib/tab-send';
import {
  hasSession,
  isContentPendingInComposer,
  sendBracketedPaste,
  sendBracketedPasteText,
} from '@/lib/tmux';

/**
 * Cookie-authed twin of `POST /api/cli/tabs/[tabId]/send`, for clients that
 * hold a `session-token` cookie instead of the CLI token — the phone must never
 * carry a token that also authorises `purplemux tab send` into every workspace.
 *
 * Auth comes entirely from the proxy (`src/proxy.ts`), which this path is under:
 * a valid session cookie or the global `x-pmux-token` passes, anything else —
 * including a workspace-scoped token — gets 401 before the handler runs. The
 * route deliberately does NOT live under `/api/cli/**` and implements none of
 * its scope rules (`canDriveWorkspace`, `allowedPeers`); agents keep using the
 * `/api/cli` send route so their confinement stays where it is enforced.
 *
 * On the `live-session` gate, so a phone can reach a `busy` agent exactly as
 * the web client does. The two routes differ in readiness on purpose — see
 * `TSendGate` in `@/lib/tab-send`.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
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
      paste: sendBracketedPaste,
      pasteWithoutSubmit: sendBracketedPasteText,
      isContentPendingInComposer,
    },
    parsed.request,
  );

  return res.status(result.status).json(result.body);
};

export default handler;
