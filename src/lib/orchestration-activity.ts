import { onTabClosed } from '@/lib/tab-lifecycle';
import { randomUUID } from 'crypto';
import { isAgentPanelType, type TAgentPanelType } from '@/lib/agent-panel-types';
import type { ITab } from '@/types/terminal';


const rawState = globalThis as unknown as { __ptRawInputEpochs?: Map<string, number>; __ptRawInputCleanup?: boolean };
const rawEpochs = rawState.__ptRawInputEpochs ??= new Map<string, number>();
if (!rawState.__ptRawInputCleanup) {
  onTabClosed(({ sessionName }) => rawEpochs.delete(sessionName));
  rawState.__ptRawInputCleanup = true;
}

/** Called under the layout lock, before any command can reach the terminal. */
export const prepareOrchestrationLaunch = (tab: ITab): void => {
  if (!isAgentPanelType(tab.panelType)) return;
  tab.orchestrationActivity = {
    sessionName: tab.sessionName, runtimeGeneration: randomUUID(), launch: { at: Date.now() },
    // A new session is not proof that the old submitted work completed.
    ...(tab.orchestrationActivity?.turn ? { turn: tab.orchestrationActivity.turn } : {}),
  };
};

export const recordOrchestrationLaunch = async (workspaceId: string, tabId: string, sessionName: string, intendedPanelType?: TAgentPanelType): Promise<void> => {
  const { mutateTabAtomically, findTabBySessionName } = await import('@/lib/layout-store');
  const { observeOrchestrationProcess } = await import('@/lib/orchestration-runtime');
  const previous = await findTabBySessionName(sessionName, workspaceId);
  if (!previous || previous.id !== tabId) throw new Error('Launch target disappeared');
  const panelType = intendedPanelType ?? previous.panelType;
  if (!isAgentPanelType(panelType)) throw new Error('Launch requires an explicit agent type');
  const prior = await observeOrchestrationProcess({ ...previous, panelType });
  const result = await mutateTabAtomically(workspaceId, tabId, (tab) => {
    if (tab.sessionName !== sessionName) throw new Error('Launch target changed');
    tab.panelType = panelType;
    prepareOrchestrationLaunch(tab);
    if (prior.state === 'present') tab.orchestrationActivity!.launch!.priorIdentity = prior.identity;
    if (prior.state === 'unknown') tab.orchestrationActivity!.launch!.priorUnknown = true;
    return { changed: true, value: undefined };
  });
  if (!result.found) throw new Error('Launch target disappeared');
};

/** Caller holds the mapping read guard through this write and terminal submission. */
export const recordOrchestrationSubmission = async (sessionName: string, rawInput = false): Promise<void> => {
  const { parseSessionName, mutateTabAtomically } = await import('@/lib/layout-store');
  const target = parseSessionName(sessionName);
  if (!target) return;
  const result = await mutateTabAtomically(target.wsId, target.tabId, (tab) => {
    if (tab.sessionName !== sessionName) throw new Error('Submission target changed');
    if (!isAgentPanelType(tab.panelType) && !tab.orchestrationActivity?.turn && !tab.orchestrationActivity?.launch) return { changed: false, value: undefined };
    const prior = tab.orchestrationActivity;
    if (rawInput && prior?.sessionName === sessionName && prior.turn?.rawInput && !prior.turn.runningAt && prior.turn.rawEpoch === (rawEpochs.get(sessionName) ?? 0)) return { changed: false, value: undefined };
    const runtimeGeneration = prior?.sessionName === sessionName ? prior.runtimeGeneration : randomUUID();
    tab.orchestrationActivity = {
      ...prior, sessionName, runtimeGeneration,
      turn: { generation: randomUUID(), runtimeGeneration, at: Date.now(), ...(rawInput ? { rawInput: true, rawEpoch: rawEpochs.get(sessionName) ?? 0 } : {}) },
    };
    return { changed: true, value: undefined };
  });
  if (!result.found) throw new Error('Submission target disappeared');
};

/**
 * Only accepted hooks with occurrence-time ordering advance persisted evidence.
 * The atomic layout mutation cannot clear a later submission or launch. Legacy
 * hooks without occurrence time cannot prove completion; close/reap can abandon
 * ambiguous work. A session-start acknowledges launch readiness, never a turn.
 */
const acknowledgeActivity = async (
  workspaceId: string, tabId: string, sessionName: string, event: string, at: number,
): Promise<void> => {
  if (!['session-start', 'prompt-submit', 'stop', 'interrupt'].includes(event)) return;
  const { mutateTabAtomically } = await import('@/lib/layout-store');
  // Capture under the same lock as a new submission. Runtime inspection may
  // await; the final compare-and-set must still name this exact generation.
  const captured = await mutateTabAtomically(workspaceId, tabId, (tab) => ({ changed: false, value: structuredClone(tab.orchestrationActivity) }));
  if (!captured.found) return;
  const snapshot = captured.value;
  if (!snapshot || captured.tab.sessionName !== sessionName || snapshot.sessionName !== sessionName) return;
  const { observeOrchestrationProcess } = await import('@/lib/orchestration-runtime');
  const observed = await observeOrchestrationProcess(captured.tab);
  if (observed.state !== 'present') return;
  await mutateTabAtomically(workspaceId, tabId, (tab) => {
    const activity = tab.orchestrationActivity;
    if (!activity || tab.sessionName !== sessionName || activity.sessionName !== sessionName || activity.runtimeGeneration !== snapshot.runtimeGeneration) return { changed: false, value: undefined };
    let changed = false;
    if (event === 'session-start' && activity.launch && !activity.launch.priorUnknown && at > activity.launch.at && observed.identity !== activity.launch.priorIdentity) {
      delete activity.launch;
      changed = true;
    }
    const turn = activity.turn;
    if (turn && turn.generation === snapshot.turn?.generation && turn.runtimeGeneration === activity.runtimeGeneration && at > turn.at) {
      if (event === 'prompt-submit' && !turn.runningAt) {
        turn.runningAt = at;
        turn.runningIdentity = observed.identity;
        changed = true;
      } else if ((event === 'stop' || event === 'interrupt') && turn.runningAt && at > turn.runningAt && turn.runningIdentity === observed.identity) {
        delete activity.turn;
        changed = true;
      }
    }
    return { changed, value: undefined };
  });
};

const globalActivity = globalThis as unknown as { __ptOrchestrationActivityAcks?: Map<string, Promise<void>> };
const acknowledgments = globalActivity.__ptOrchestrationActivityAcks ??= new Map<string, Promise<void>>();

/** Preserve accepted hook order while process observations await. */
export const acknowledgeOrchestrationActivity = (
  workspaceId: string, tabId: string, sessionName: string, event: string, at: number,
): Promise<void> => {
  // Accepted prompt-submit invalidates raw coalescing immediately, before its
  // asynchronous process observation can finish. Later bytes need a new epoch.
  if (event === 'prompt-submit') rawEpochs.set(sessionName, (rawEpochs.get(sessionName) ?? 0) + 1);
  const key = `${workspaceId}:${tabId}`;
  const prior = acknowledgments.get(key) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(() => acknowledgeActivity(workspaceId, tabId, sessionName, event, at));
  acknowledgments.set(key, next);
  const retire = () => { if (acknowledgments.get(key) === next) acknowledgments.delete(key); };
  void next.then(retire, retire);
  return next;
};
