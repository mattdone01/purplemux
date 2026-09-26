import type { NextApiRequest, NextApiResponse } from 'next';
import { getLayout, addTabToPane, isAgentPanelType } from '@/lib/layout-store';
import { collectPanes } from '@/lib/layout-tree';
import { getWorkspaceById, getWorkspaces } from '@/lib/workspace-store';
import { authorizeWorkspace, canAccessWorkspace, resolveFirstPaneId } from '@/lib/cli-utils';
import { resolveCliScope } from '@/lib/workspace-token';
import { getProviderByPanelType } from '@/lib/providers';
import { checkAgentAvailabilityForPanelType, toAgentAvailabilityError } from '@/lib/agent-availability';
import { isValidReasoningForPanelType, reasoningErrorForPanelType } from '@/lib/agent-effort';
import { buildClaudeFlags, isValidModelName } from '@/lib/claude-command';
import { grokProvider } from '@/lib/providers/grok';
import { getStatusManager } from '@/lib/status-manager';
import { createLogger } from '@/lib/logger';
import { agentLaunchConfigFromOptions } from '@/lib/agent-launch-policy';
import { checkAgentDispatchPolicy } from '@/lib/agent-dispatch-policy';
import {
  prepareCodexManagedLaunch,
  submitCodexManagedLaunch,
  waitForCodexManagedLaunch,
} from '@/lib/providers/codex/managed-launch';
import type { TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';
import type { ILastEvent } from '@/types/status';

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
      agentLaunchConfig?: { model?: string; effort?: string };
      cliState: TCliState | null;
      lastEvent: ILastEvent | null;
      busySince: number | null;
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
    // Live state lets a deploy drain tell a mid-turn agent from one kept busy
    // only by open background work (last event `stop`).
    const liveStatus = getStatusManager().getAllForClient();

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
            agentLaunchConfig: tab.agentLaunchConfig,
            cliState: liveStatus[tab.id]?.cliState ?? tab.cliState ?? null,
            lastEvent: liveStatus[tab.id]?.lastEvent ?? null,
            busySince: liveStatus[tab.id]?.busySince ?? null,
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
    const dispatchPolicy = await checkAgentDispatchPolicy(workspaceId);
    if (!dispatchPolicy.ok) {
      return res.status(409).json(dispatchPolicy);
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
    // Each engine has its own effort vocabulary; validate against the one the
    // tab will actually launch so a typo fails here, not silently at runtime.
    if (reasoning !== undefined) {
      if (!isValidReasoningForPanelType(resolvedType, reasoning)) {
        return res.status(400).json({ error: reasoningErrorForPanelType(resolvedType) });
      }
    }

    // Agent tabs launch their CLI by default (mirrors UI tab creation) —
    // a bare shell made `tab send` briefs land in bash, not the agent.
    const shouldLaunch = launch !== false && isAgentPanelType(resolvedType);
    let command: string | undefined;
    if (shouldLaunch) {
      if (resolvedType === 'claude-code') {
        command = `claude ${await buildClaudeFlags(workspaceId, { model, effort: reasoning })}`;
      } else if (resolvedType === 'grok-cli') {
        // Catch-all else is codex; routing grok through it launched codex
        // inside a grok tab. Pin model/effort at launch the same as the others.
        command = await grokProvider.buildLaunchCommand({ workspaceId, model, effort: reasoning });
      }
    }

    try {
      const tab = await addTabToPane(workspaceId, paneId, name, ws.directories[0], resolvedType, command, {
        scope: scope as string[] | undefined,
        agentLaunchConfig: agentLaunchConfigFromOptions(model, reasoning),
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

      let codexLaunchState: 'active' | 'held' | undefined;
      if (shouldLaunch && resolvedType === 'codex-cli') {
        const prepared = await prepareCodexManagedLaunch(workspaceId, tab.id);
        if (!prepared.ok) {
          return res.status(500).json({
            error: 'Failed to prepare Codex launch',
            reason: prepared.reason,
            tabId: tab.id,
            launchState: 'held',
          });
        }
        const submitted = await submitCodexManagedLaunch(workspaceId, tab.id, prepared.launch.generation);
        if (!submitted.ok) {
          return res.status(500).json({
            error: 'Failed to submit Codex launch',
            reason: submitted.reason,
            tabId: tab.id,
            generation: submitted.generation,
            launchState: submitted.phase,
          });
        }
        const activated = await waitForCodexManagedLaunch(workspaceId, tab.id, submitted.generation);
        codexLaunchState = activated.ok ? activated.phase : 'held';
        if (!activated.ok) {
          return res.status(503).json({
            error: 'Codex launch was not confirmed',
            reason: activated.reason,
            tabId: tab.id,
            generation: activated.generation,
            launchState: activated.phase,
          });
        }
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
        agentLaunchConfig: tab.agentLaunchConfig,
        launched: !!command || codexLaunchState === 'active',
        ...(codexLaunchState ? { launchState: codexLaunchState } : {}),
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
