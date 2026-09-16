import type { NextApiRequest, NextApiResponse } from 'next';
import { addTabToPane, updateTabAgentSessionId } from '@/lib/layout-store';
import { getActiveWorkspaceId } from '@/lib/workspace-store';
import { getStatusManager } from '@/lib/status-manager';
import { getProviderByPanelType } from '@/lib/providers';
import { checkAgentAvailabilityForPanelType, toAgentAvailabilityError } from '@/lib/agent-availability';
import { sendKeys } from '@/lib/tmux';
import { createLogger } from '@/lib/logger';
import { CODEX_PROVIDER_ID } from '@/lib/providers/codex';
import {
  prepareCodexManagedLaunch,
  submitCodexManagedLaunch,
  waitForCodexManagedLaunch,
} from '@/lib/providers/codex/managed-launch';

const log = createLogger('layout');

const SHELL_READY_DELAY_MS = 500;

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const wsId = (req.query.workspace as string) || await getActiveWorkspaceId();
  if (!wsId) {
    return res.status(400).json({ error: 'No workspace found' });
  }

  const paneId = req.query.paneId as string;
  const { name, cwd, panelType, command, resumeSessionId } = req.body ?? {};

  const provider = resumeSessionId ? getProviderByPanelType(panelType ?? 'claude-code') : null;
  if (resumeSessionId) {
    if (!provider) {
      return res.status(400).json({ error: 'Unknown panel type for resume' });
    }
    if (!provider.isValidSessionId(resumeSessionId)) {
      return res.status(400).json({ error: 'Invalid session ID format' });
    }
  }
  const availability = await checkAgentAvailabilityForPanelType(provider?.panelType ?? panelType);
  if (!availability.ok) {
    return res.status(availability.status).json(toAgentAvailabilityError(availability));
  }

  try {
    const managedCodex = panelType === 'codex-cli';
    const tab = await addTabToPane(wsId, paneId, name, cwd, panelType, managedCodex ? undefined : command);
    if (!tab) {
      return res.status(404).json({ error: 'Pane not found' });
    }

    if (resumeSessionId && provider && !command && provider.id !== CODEX_PROVIDER_ID) {
      provider.writeSessionId(tab, resumeSessionId);
      await updateTabAgentSessionId(tab.sessionName, provider, resumeSessionId);
    }

    if (tab.panelType !== 'web-browser') {
      const tabProvider = getProviderByPanelType(tab.panelType);
      getStatusManager().registerTab(tab.id, {
        cliState: 'inactive',
        workspaceId: wsId,
        tabName: tab.name,
        tmuxSession: tab.sessionName,
        panelType: tab.panelType,
        agentProviderId: tabProvider?.id,
        agentSessionId: tabProvider?.readSessionId(tab) ?? null,
        lastEvent: null,
        eventSeq: 0,
      });
      if (command && !managedCodex) {
        getStatusManager().markAgentLaunch(tab.id);
      }
    }

    if (managedCodex && (command || resumeSessionId)) {
      const prepared = await prepareCodexManagedLaunch(wsId, tab.id, resumeSessionId ?? null);
      if (!prepared.ok) {
        return res.status(500).json({ error: 'Failed to prepare Codex launch', reason: prepared.reason });
      }
      const submitted = await submitCodexManagedLaunch(wsId, tab.id, prepared.launch.generation);
      if (!submitted.ok) {
        return res.status(500).json({ error: 'Failed to submit Codex launch', reason: submitted.reason });
      }
      const activated = await waitForCodexManagedLaunch(wsId, tab.id, submitted.generation);
      if (!activated.ok) {
        return res.status(503).json({ error: 'Codex launch was not confirmed', reason: activated.reason });
      }
    }

    if (resumeSessionId && provider && !command && provider.id !== CODEX_PROVIDER_ID) {
      setTimeout(async () => {
        try {
          const resumeCmd = await provider.buildResumeCommand(resumeSessionId, { workspaceId: wsId });
          await sendKeys(tab.sessionName, resumeCmd);
          getStatusManager().markAgentLaunch(tab.id);
        } catch (err) {
          log.warn(`resume sendKeys failed: ${err instanceof Error ? err.message : err}`);
        }
      }, SHELL_READY_DELAY_MS);
    }

    return res.status(200).json(tab);
  } catch (err) {
    log.error(`tab creation failed: ${err instanceof Error ? err.message : err}`);
    return res.status(500).json({ error: 'Failed to create tab' });
  }
};

export default handler;
