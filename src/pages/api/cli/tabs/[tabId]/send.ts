import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspaceInput, findTab } from '@/lib/cli-utils';
import { getStatusManager } from '@/lib/status-manager';
import {
  awaitSendReadiness,
  MAX_SEND_READY_TIMEOUT_MS,
  resolveSendWaitMs,
  resolveTabCliState,
} from '@/lib/tab-send';
import { sendBracketedPaste, hasSession, isContentPendingInComposer } from '@/lib/tmux';

/**
 * Deliver a prompt to a tab.
 *
 * The send holds until the target can accept a turn, because the alternative
 * cost fifty minutes of an epic: three workers were sent their briefs while
 * their agent TUIs were still booting, the pastes landed in input boxes whose
 * Enter was swallowed, and every call answered `submitted: true` over agents
 * that never started. A tab that never starts never changes state, so nothing
 * downstream surfaced it either.
 *
 * `waitMs: 0` opts out and answers with whatever the tab is doing right now.
 * On timeout nothing is pasted at all — half a brief sitting in a composer for
 * a stray Enter to submit is worse than no brief.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tabId = req.query.tabId as string;
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId is required' });
  }

  if (!(await authorizeWorkspaceInput(req, res, workspaceId))) return;

  const { content, waitMs } = (req.body ?? {}) as { content?: string; waitMs?: unknown };
  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }
  const timeoutMs = resolveSendWaitMs(waitMs);
  if (timeoutMs === null) {
    return res
      .status(400)
      .json({ error: `waitMs must be an integer between 0 and ${MAX_SEND_READY_TIMEOUT_MS}` });
  }

  const readiness = await awaitSendReadiness(
    {
      findTarget: async (wsId, id) => {
        const found = await findTab(wsId, id);
        if (!found) return null;
        return {
          sessionName: found.tab.sessionName,
          panelType: found.tab.panelType,
          cliState: resolveTabCliState(found.tab, getStatusManager().getAllForClient()[id]),
        };
      },
      hasSession,
    },
    // `composer-ready`, not `live-session`: this is the unattended dispatch
    // path, where a paste that beats the TUI's boot is silently swallowed. The
    // cookie-authed route a person types into does NOT wait — see TSendGate.
    { workspaceId, tabId, timeoutMs, gate: 'composer-ready' },
  );

  if (!readiness.ok) {
    if (readiness.reason === 'tab-not-found') return res.status(404).json({ error: 'Tab not found' });
    return res.status(409).json({
      error: 'agent-not-ready',
      tabId,
      cliState: readiness.cliState,
      detail: readiness.reason,
      ...(readiness.reason === 'readiness-timeout' ? { waitedMs: readiness.waitedMs } : {}),
    });
  }

  await sendBracketedPaste(readiness.target.sessionName, content);

  // Report delivery, not just dispatch. A paste that lands while the agent is
  // mid-turn can have its Enter swallowed and sit in the composer until
  // somebody else's keystroke submits it, so a caller that reads only
  // `status` cannot tell a queued message from a stranded one. `pending` is
  // best-effort and never fatal: the send DID happen either way.
  const pending = await isContentPendingInComposer(readiness.target.sessionName, content).catch(() => false);
  return res.status(200).json({
    status: 'sent',
    submitted: !pending,
    cliState: readiness.target.cliState,
  });
};

export default handler;
