import { findTab } from '@/lib/cli-utils';
import { getWorkspaceById } from '@/lib/workspace-store';
import { withOrchestrationMappingRead } from '@/lib/orchestration-mapping-lock';
import {
  claimCodexBootstrapLocked,
  withCodexTargetLock,
} from '@/lib/providers/codex/launch-lifecycle';
import { getCodexModelStatus, type ICodexModelStatus } from '@/lib/providers/codex/model-observation';
import type { ITab } from '@/types/terminal';

export interface IAgentDispatchPolicyOptions {
  consumeBootstrapForTarget?: boolean;
}

export type TAgentDispatchPolicyResult =
  | { ok: true }
  | {
      ok: false;
      error: 'agent-model-mismatch' | 'agent-model-unverified';
      tabId: string;
      modelStatus: ICodexModelStatus;
    };

export type TAgentDispatchPolicyCheck = (
  options?: IAgentDispatchPolicyOptions,
) => Promise<TAgentDispatchPolicyResult>;

const unverified = (tabId: string, target?: ITab): TAgentDispatchPolicyResult => ({
  ok: false,
  error: 'agent-model-unverified',
  tabId,
  modelStatus: {
    expected: {
      model: target?.agentLaunchConfig?.model ?? null,
      effort: target?.agentLaunchConfig?.effort ?? null,
    },
    observed: null,
    latestTurn: null,
    latestSettings: null,
    scanState: 'unavailable',
    hasActivity: false,
    status: 'unknown',
    reason: 'lifecycle-unverified',
  },
});

const getOrchestratorId = async (workspaceId: string): Promise<string | null> => {
  const workspace = await getWorkspaceById(workspaceId);
  return workspace?.orchestration?.enabled
    ? workspace.orchestration.orchestratorTabId ?? null
    : null;
};

/**
 * Requires both target and the supplied crown's lifecycle locks through submission.
 * A changed crown mapping must not cause inspection of a newly unlocked crown.
 */
export const checkAgentDispatchPolicyLocked = async (
  workspaceId: string,
  target: ITab | undefined,
  lockedOrchestratorId: string | null,
  options: IAgentDispatchPolicyOptions = {},
): Promise<TAgentDispatchPolicyResult> => {
  const foundTarget = target ? await findTab(workspaceId, target.id) : null;
  if (target && (!foundTarget || foundTarget.tab.sessionName !== target.sessionName)) {
    return unverified(target.id, target);
  }
  const currentTarget = foundTarget?.tab;
  const orchestratorId = await getOrchestratorId(workspaceId);
  if (orchestratorId !== lockedOrchestratorId) {
    return unverified(orchestratorId ?? target?.id ?? lockedOrchestratorId ?? '');
  }
  const tabs = currentTarget ? [currentTarget] : [];
  if (orchestratorId && orchestratorId !== currentTarget?.id) {
    const found = await findTab(workspaceId, orchestratorId);
    if (!found) return unverified(orchestratorId);
    tabs.push(found.tab);
  }

  let targetAwaitingFirstTurn: { tab: ITab; modelStatus: ICodexModelStatus } | null = null;
  for (const tab of tabs) {
    if (tab.panelType !== 'codex-cli') continue;
    const modelStatus = await getCodexModelStatus(tab);
    if (modelStatus.status === 'mismatch') {
      return { ok: false, error: 'agent-model-mismatch', tabId: tab.id, modelStatus };
    }
    if (modelStatus.status !== 'unknown') continue;

    const mayClaimLater = options.consumeBootstrapForTarget === true
      && currentTarget?.id === tab.id
      && modelStatus.reason === 'awaiting-first-turn';
    if (mayClaimLater) {
      targetAwaitingFirstTurn = { tab, modelStatus };
      continue;
    }
    return { ok: false, error: 'agent-model-unverified', tabId: tab.id, modelStatus };
  }
  if (targetAwaitingFirstTurn) {
    const claim = await claimCodexBootstrapLocked(workspaceId, targetAwaitingFirstTurn.tab.id);
    if (!claim.ok) {
      return {
        ok: false,
        error: 'agent-model-unverified',
        tabId: targetAwaitingFirstTurn.tab.id,
        modelStatus: claim.modelStatus ?? targetAwaitingFirstTurn.modelStatus,
      };
    }
  }
  if (await getOrchestratorId(workspaceId) !== lockedOrchestratorId) {
    return unverified(target?.id ?? lockedOrchestratorId ?? '');
  }
  return { ok: true };
};

/** Keep the final check and terminal submission inside work; never nest target locks. */
export const withAgentDispatchLock = async <T>(
  workspaceId: string,
  target: ITab | undefined,
  work: (checkPolicy: TAgentDispatchPolicyCheck) => Promise<T>,
): Promise<T> => withOrchestrationMappingRead(workspaceId, async () => {
  const orchestratorId = await getOrchestratorId(workspaceId);
  const tabIds = [...new Set([target?.id, orchestratorId].filter((id): id is string => !!id))].sort();
  const acquire = (index: number): Promise<T> => index < tabIds.length
    ? withCodexTargetLock(workspaceId, tabIds[index], () => acquire(index + 1))
    : work((options) => checkAgentDispatchPolicyLocked(workspaceId, target, orchestratorId, options));
  return acquire(0);
});

/** Called only after the request's workspace authorization succeeds. */
export const checkAgentDispatchPolicy = async (
  workspaceId: string,
  target?: ITab,
  options: IAgentDispatchPolicyOptions = {},
): Promise<TAgentDispatchPolicyResult> =>
  withAgentDispatchLock(workspaceId, target, (checkPolicy) => checkPolicy(options));

/** Test-only compatibility; persisted lifecycle state has no in-memory claims. */
export const clearAgentDispatchPolicyState = (): void => {};
