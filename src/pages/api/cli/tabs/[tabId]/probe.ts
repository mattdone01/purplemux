import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace, authorizeWorkspaceInput, findTab } from '@/lib/cli-utils';
import { getLivenessManager } from '@/lib/liveness-manager';
import type { ILivenessProbe } from '@/types/liveness';

const MIN_INTERVAL_S = 30;
const DEFAULT_INTERVAL_S = 60;
const MIN_THRESHOLD_S = 60;
const MAX_S = 7 * 24 * 3600;
const MAX_COMMAND_LEN = 2000;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Registering a probe makes the server execute a command, so writes take the
// input-grade authorization (the workspace's own token); reads take read-grade.
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const tabId = req.query.tabId as string;
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  if (req.method === 'GET') {
    if (!(await authorizeWorkspace(req, res, workspaceId))) return;
    if (!(await findTab(workspaceId, tabId))) return res.status(404).json({ error: 'Tab not found' });
    const { probes } = await getLivenessManager().statusForTab(tabId);
    return res.status(200).json({ tabId, workspaceId, probes });
  }

  if (req.method === 'POST') {
    if (!(await authorizeWorkspaceInput(req, res, workspaceId))) return;
    if (!(await findTab(workspaceId, tabId))) return res.status(404).json({ error: 'Tab not found' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!command || command.length > MAX_COMMAND_LEN) {
      return res.status(400).json({ error: `command is required (non-empty, at most ${MAX_COMMAND_LEN} chars)` });
    }
    const stalenessThresholdS = Number(body.stalenessThresholdS);
    if (!Number.isFinite(stalenessThresholdS) || stalenessThresholdS < MIN_THRESHOLD_S || stalenessThresholdS > MAX_S) {
      return res.status(400).json({ error: `stalenessThresholdS must be ${MIN_THRESHOLD_S}..${MAX_S} seconds` });
    }
    const intervalS = body.intervalS === undefined ? DEFAULT_INTERVAL_S : Number(body.intervalS);
    if (!Number.isFinite(intervalS) || intervalS < MIN_INTERVAL_S || intervalS > MAX_S) {
      return res.status(400).json({ error: `intervalS must be ${MIN_INTERVAL_S}..${MAX_S} seconds` });
    }
    const label = body.label === undefined ? 'default' : String(body.label);
    if (!LABEL_RE.test(label)) {
      return res.status(400).json({ error: 'label must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}' });
    }

    const probe: ILivenessProbe = {
      workspaceId,
      tabId,
      label,
      command,
      stalenessThresholdS: Math.round(stalenessThresholdS),
      intervalS: Math.round(intervalS),
      registeredAt: Date.now(),
    };
    await getLivenessManager().registerProbe(probe);
    return res.status(200).json({ tabId, workspaceId, probe });
  }

  if (req.method === 'DELETE') {
    if (!(await authorizeWorkspaceInput(req, res, workspaceId))) return;
    const label = typeof req.query.label === 'string' ? req.query.label : undefined;
    const removed = await getLivenessManager().unregisterProbes(workspaceId, tabId, label);
    return res.status(200).json({ tabId, workspaceId, removed });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
