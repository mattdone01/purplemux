import type { NextApiRequest, NextApiResponse } from 'next';
import { getLayout, addTabToPane, isAgentPanelType } from '@/lib/layout-store';
import { collectPanes } from '@/lib/layout-tree';
import { getWorkspaceById, getWorkspaces } from '@/lib/workspace-store';
import { authorizeWorkspace, canAccessWorkspace, resolveFirstPaneId } from '@/lib/cli-utils';
import { resolveCliScope } from '@/lib/workspace-token';
import { getProviderByPanelType } from '@/lib/providers';
import { checkAgentAvailabilityForPanelType, toAgentAvailabilityError } from '@/lib/agent-availability';
import { buildClaudeFlags, isValidModelName } from '@/lib/claude-command';
import { codexProvider } from '@/lib/providers/codex';
import { getStatusManager } from '@/lib/status-manager';
import { createLogger } from '@/lib/logger';
import type { TPanelType } from '@/types/terminal';

const log = createLogger('api:cli:tabs');

const VALID_PANEL_TYPES: TPanelType[] = ['terminal', 'claude-code', 'codex-cli', 'grok-cli', 'agent-sessions', 'web-browser', 'diff'];

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const cliScope = resolveCliScope(req);
  if (!cliScope) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.method === 'GET') {
    const wsId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
    if (wsId && !(await authorizeWorkspace(req, res, wsId))) return;
    const tabs: Array<{
      tabId: string;
      workspaceId: string;
      name: string;
      sessionName: string;
      panelType?: string;
      agentProviderId: string | null;
      agentSessionId: string | null;
    }> = [];

    // An unscoped list must not become a directory of every other epic's
    // workers: a workspace-scoped caller sees only what it may already act on.
    const allWorkspaceIds = (await getWorkspaces()).workspaces.map((w) => w.id);
    const visibleIds = wsId
      ? [wsId]
      : (await Promise.all(
          allWorkspaceIds.map(async (id) => ((await canAccessWorkspace(cliScope, id)) ? id : null)),
        )).filter((id): id is string => id !== null);
    const workspaceIds = visibleIds;

    for (const id of workspaceIds) {
      const ws = await getWorkspaceById(id);
      if (!ws) continue;
      const layout = await getLayout(id);
      for (const pane of collectPanes(layout.root)) {
        for (const tab of pane.tabs) {
          const provider = getProviderByPanelType(tab.panelType);
          tabs.push({
            tabId: tab.id,
            workspaceId: id,
            name: tab.name,
            sessionName: tab.sessionName,
            panelType: tab.panelType,
            agentProviderId: provider?.id ?? null,
            agentSessionId: provider?.readSessionId(tab) ?? null,
          });
        }
      }
    }
    return res.status(200).json({ tabs });
  }

  if (req.method === 'POST') {
    const { workspaceId, name, panelType, model, reasoning, launch, scope } = req.body as {
      workspaceId?: string;
      name?: string;
      panelType?: string;
      model?: string;
      reasoning?: string;
      launch?: boolean;
      scope?: unknown;
    };
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required' });
    }
    if (!(await authorizeWorkspace(req, res, workspaceId))) return;
    if (scope !== undefined && (!Array.isArray(scope) || scope.some((s) => typeof s !== 'string'))) {
      return res.status(400).json({ error: 'scope must be an array of path globs' });
    }
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    const paneId = await resolveFirstPaneId(workspaceId);
    if (!paneId) {
      return res.status(500).json({ error: 'No pane available in workspace' });
    }
    if (panelType !== undefined && !VALID_PANEL_TYPES.includes(panelType as TPanelType)) {
      return res.status(400).json({
        error: 'Invalid panelType',
        validPanelTypes: VALID_PANEL_TYPES,
      });
    }
    const resolvedType: TPanelType = panelType ? (panelType as TPanelType) : 'terminal';
    const availability = await checkAgentAvailabilityForPanelType(resolvedType);
    if (!availability.ok) {
      return res.status(availability.status).json(toAgentAvailabilityError(availability));
    }
    if (model !== undefined && !isValidModelName(model)) {
      return res.status(400).json({ error: 'Invalid model' });
    }
    if (reasoning !== undefined && !/^(minimal|low|medium|high)$/.test(String(reasoning))) {
      return res.status(400).json({ error: 'Invalid reasoning (minimal|low|medium|high)' });
    }

    // Agent tabs launch their CLI by default (mirrors UI tab creation) —
    // a bare shell made `tab send` briefs land in bash, not the agent.
    const shouldLaunch = launch !== false && isAgentPanelType(resolvedType);
    let command: string | undefined;
    if (shouldLaunch) {
      if (resolvedType === 'claude-code') {
        command = `claude ${await buildClaudeFlags(workspaceId, { model })}`;
      } else {
        command = await codexProvider.buildLaunchCommand({ workspaceId });
        if (model) command += ` --model ${model}`;
        if (reasoning) command += ` -c model_reasoning_effort=${reasoning}`;
      }
    }

    try {
      const tab = await addTabToPane(workspaceId, paneId, name, ws.directories[0], resolvedType, command, {
        scope: scope as string[] | undefined,
      });
      if (!tab) return res.status(500).json({ error: 'Failed to create tab' });

      if (tab.panelType !== 'web-browser') {
        const provider = getProviderByPanelType(tab.panelType);
        getStatusManager().registerTab(tab.id, {
          cliState: 'inactive',
          workspaceId,
          tabName: tab.name,
          tmuxSession: tab.sessionName,
          panelType: tab.panelType,
          agentProviderId: provider?.id,
          agentSessionId: provider?.readSessionId(tab) ?? null,
          lastEvent: null,
          eventSeq: 0,
        });
        if (command) getStatusManager().markAgentLaunch(tab.id);
      }

      return res.status(201).json({
        tabId: tab.id,
        workspaceId,
        paneId,
        sessionName: tab.sessionName,
        name: tab.name,
        panelType: tab.panelType,
        agentProviderId: null,
        agentSessionId: null,
        launched: !!command,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      log.error(`create tab failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
