import { deliverPrompt } from '@/lib/agent-prompt-delivery';
import { withAgentDispatchLock } from '@/lib/agent-dispatch-policy';
import { isAgentPanelType, processMatchesPanelType } from '@/lib/agent-panel-types';
import { capturePaneAtWidth } from '@/lib/capture-at-width';
import { findTab } from '@/lib/cli-utils';
import { collectAllTabs, readLayoutFile, resolveLayoutFile } from '@/lib/layout-store';
import { createLogger } from '@/lib/logger';
import { parsePermissionOptions } from '@/lib/permission-prompt';
import { getProviderByPanelType } from '@/lib/providers/registry';
import { verifyCodexActiveRuntime } from '@/lib/providers/codex/launch-lifecycle';
import { getChildPids } from '@/lib/process-utils';
import { readStandups } from '@/lib/standup-store';
import { getStatusManager } from '@/lib/status-manager';
import { getAllPanesInfo } from '@/lib/tmux';
import { getWorkspaces } from '@/lib/workspace-store';
import {
  getMissionControlStore,
  type IMissionBootstrapQueueEntry,
  type IMissionDeliveryOutcome,
  type IMissionDiscoveryCandidate,
  type IMissionDiscoveryInput,
  type IMissionDiscoveryRun,
  type IMissionDiscoveryWorkspace,
  type MissionControlStore,
  type TMissionDeliveryValidation,
} from '@/lib/mission-control-store';
import type {
  IMissionAgentObservation,
  IMissionBinding,
  IMissionBootstrap,
  IMissionBootstrapEntry,
  IMissionDelivery,
  IMissionEvidence,
  IMissionSnapshot,
  IMissionWorkspaceView,
  TMissionActivity,
} from '@/types/mission-control';
import type { IWorkspaceStandup } from '@/types/status';
import type { ITab, TPanelType } from '@/types/terminal';

const log = createLogger('mission-control-runtime');

const DELIVERY_LIMIT = 20;
const BOOTSTRAP_LIMIT = 10;
const WORKER_INTERVAL_MS = 1_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;
const STALE_BUSY_MS = 10 * 60_000;
const RECENT_STANDUP_MS = 30 * 60_000;

export type IMissionControlRuntimeStore = Pick<MissionControlStore,
  | 'snapshot'
  | 'reconcileDiscovery'
  | 'listDueDeliveries'
  | 'claimDelivery'
  | 'validateDeliveryAttempt'
  | 'finalizeDeliveryAttempt'
  | 'recoverDispatching'
  | 'listQueuedBootstrapEntries'
  | 'claimBootstrapEntry'
  | 'validateBootstrapAttempt'
  | 'completeBootstrapAttempt'
>;

export interface IMissionRuntimeDeps {
  getStore: () => IMissionControlRuntimeStore;
  now: () => number;
  discover: (bootstrapId: string, reconcile: boolean, boundarySeq: number) => Promise<IMissionDiscoveryInput>;
  workspaceViews: () => Promise<IMissionWorkspaceView[]>;
  resolveIdentity: (workspaceId: string, tabId: string) => Promise<Omit<IMissionBinding, 'generation'> | null>;
  dispatch: (request: IMissionDispatchRequest) => Promise<TMissionDispatchResult>;
  setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
}

export interface IMissionDispatchRequest {
  workspaceId: string;
  binding: IMissionBinding;
  message: string;
  preflight?: () => TMissionDeliveryValidation;
}

export type TMissionDispatchResult =
  | { delivered: true }
  | {
      delivered: false;
      retryable: boolean;
      uncertain: boolean;
      reason: string;
    };

interface ILiveTab {
  tab: ITab;
  providerId: string;
  sessionId: string;
  runtimeGeneration: string | null;
}

const maxTimestamp = (values: Array<number | null | undefined>): number | null => {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return present.length > 0 ? Math.max(...present) : null;
};

const standupContentKey = (standup: IWorkspaceStandup): string => JSON.stringify({
  state: standup.state,
  headline: standup.headline,
  items: standup.items,
  blockers: standup.blockers,
  needsHuman: standup.needsHuman,
  next: standup.next,
});

const stableTextKey = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const latestMeaningfulStandupAt = (standups: IWorkspaceStandup[]): number | null => {
  for (let index = 0; index < standups.length; index += 1) {
    const current = standups[index];
    const previous = standups[index + 1];
    if (!previous || standupContentKey(current) !== standupContentKey(previous)) return current.at;
  }
  return null;
};

const isSubstantiveStandup = (standup: IWorkspaceStandup): boolean =>
  standup.headline.trim().length > 0
  || standup.items.some((item) => item.label.trim().length > 0 || (item.note?.trim().length ?? 0) > 0)
  || standup.blockers.some((blocker) => blocker.what.trim().length > 0 || blocker.needs.trim().length > 0)
  || standup.next.some((step) => step.trim().length > 0);

const runtimeGenerationFor = (tab: ITab): string | null => {
  if (tab.panelType !== 'codex-cli') return null;
  const runtime = tab.codexLaunchRuntime;
  if (runtime?.pending || runtime?.active?.phase !== 'active') return null;
  return runtime.active.generation;
};

const missionIdentityFor = (
  tab: ITab,
  providerId: string,
  sessionId: string,
): Omit<IMissionBinding, 'generation'> => ({
  tabId: tab.id,
  providerId,
  sessionId,
  runtimeGeneration: runtimeGenerationFor(tab),
});

const missionIdentityKey = (identity: Omit<IMissionBinding, 'generation'>): string =>
  [identity.tabId, identity.providerId, identity.sessionId, identity.runtimeGeneration ?? '']
    .map((part) => encodeURIComponent(part))
    .join(':');

export const normalizeMissionIdentities = (
  identities: Array<Omit<IMissionBinding, 'generation'>>,
): Array<Omit<IMissionBinding, 'generation'>> => {
  const identityByKey = new Map(identities.map((identity) => [missionIdentityKey(identity), identity]));
  return [...identityByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, identity]) => identity);
};

export const missionLiveRunSourceKey = (
  workspaceId: string,
  identities: Array<Omit<IMissionBinding, 'generation'>>,
): string | null => {
  const normalized = normalizeMissionIdentities(identities);
  return normalized.length > 0
    ? `workspace:${workspaceId}:live:${normalized.map(missionIdentityKey).join('|')}`
    : null;
};

const sameIdentity = (
  binding: IMissionBinding,
  identity: Omit<IMissionBinding, 'generation'>,
): boolean => binding.tabId === identity.tabId
  && binding.providerId === identity.providerId
  && binding.sessionId === identity.sessionId
  && binding.runtimeGeneration === identity.runtimeGeneration;

const tail = (content: string, lines = 24): string => content.split('\n').slice(-lines).join('\n');

export const hasEmptyAgentComposer = (panelType: TPanelType | undefined, content: string): boolean => {
  const marker = panelType === 'codex-cli'
    ? '›'
    : panelType === 'claude-code'
      ? '❯'
      : panelType === 'grok-cli'
        ? '[›❯>]'
        : null;
  if (!marker) return false;
  const composerLines = tail(content, 12).split('\n');
  const composerPattern = new RegExp(`^[ \\t]*${marker}([ \\t\\u00a0].*)?$`);
  for (let index = composerLines.length - 1; index >= 0; index -= 1) {
    const match = composerLines[index].match(composerPattern);
    if (!match) continue;
    return (match[1] ?? '').trim() === '';
  }
  return false;
};

const inspectLiveTab = async (workspaceId: string, tabId: string): Promise<ILiveTab | null> => {
  const found = await findTab(workspaceId, tabId);
  if (!found || !isAgentPanelType(found.tab.panelType)) return null;
  const provider = getProviderByPanelType(found.tab.panelType);
  if (!provider) return null;

  const status = getStatusManager().getAllForClient()[tabId];
  if (!status || status.workspaceId !== workspaceId || status.agentProviderId !== provider.id) return null;
  const sessionId = status.agentSessionId;
  if (!sessionId || !provider.isValidSessionId(sessionId)) return null;

  const panes = await getAllPanesInfo();
  const pane = panes.get(found.tab.sessionName);
  if (!pane?.pid) return null;
  if (!processMatchesPanelType(found.tab.panelType, pane.command)) return null;
  const childPids = await getChildPids(pane.pid);
  if (!await provider.isAgentRunning(pane.pid, childPids)) return null;

  if (found.tab.panelType === 'codex-cli') {
    if (!runtimeGenerationFor(found.tab)) return null;
    const verified = await verifyCodexActiveRuntime(found.tab);
    if (!verified.ok) return null;
  }

  return {
    tab: found.tab,
    providerId: provider.id,
    sessionId,
    runtimeGeneration: runtimeGenerationFor(found.tab),
  };
};

export const resolveMissionTargetIdentity = async (
  workspaceId: string,
  tabId: string,
): Promise<Omit<IMissionBinding, 'generation'> | null> => {
  const live = await inspectLiveTab(workspaceId, tabId);
  return live ? missionIdentityFor(live.tab, live.providerId, live.sessionId) : null;
};

export const dispatchMissionPrompt = async (request: IMissionDispatchRequest): Promise<TMissionDispatchResult> => {
  const found = await findTab(request.workspaceId, request.binding.tabId);
  if (!found) return { delivered: false, retryable: false, uncertain: false, reason: 'binding-tab-missing' };

  try {
    return await withAgentDispatchLock(request.workspaceId, found.tab, async (checkPolicy) => {
      const current = await findTab(request.workspaceId, request.binding.tabId);
      if (!current || current.tab.sessionName !== found.tab.sessionName) {
        return { delivered: false, retryable: false, uncertain: false, reason: 'binding-tab-changed' };
      }

      const live = await inspectLiveTab(request.workspaceId, request.binding.tabId);
      if (!live) return { delivered: false, retryable: false, uncertain: false, reason: 'bound-agent-not-live' };
      const identity = missionIdentityFor(live.tab, live.providerId, live.sessionId);
      if (!sameIdentity(request.binding, identity)) {
        return { delivered: false, retryable: false, uncertain: false, reason: 'binding-identity-changed' };
      }

      const policy = await checkPolicy();
      if (!policy.ok) {
        return { delivered: false, retryable: false, uncertain: false, reason: policy.error };
      }

      const status = getStatusManager().getAllForClient()[request.binding.tabId];
      if (!status) return { delivered: false, retryable: true, uncertain: false, reason: 'status-unavailable' };
      if (status.permissionRequest) {
        return { delivered: false, retryable: true, uncertain: false, reason: 'native-prompt-active' };
      }
      if (status.cliState !== 'idle' && status.cliState !== 'ready-for-review') {
        return { delivered: false, retryable: true, uncertain: false, reason: `composer-not-ready:${status.cliState}` };
      }

      const content = await capturePaneAtWidth(live.tab.sessionName, 120, 50).catch(() => null);
      if (!content) return { delivered: false, retryable: true, uncertain: false, reason: 'composer-unreadable' };
      if (parsePermissionOptions(tail(content)).options.length > 0) {
        return { delivered: false, retryable: true, uncertain: false, reason: 'interactive-prompt-active' };
      }
      if (!hasEmptyAgentComposer(live.tab.panelType, content)) {
        return { delivered: false, retryable: true, uncertain: false, reason: 'composer-not-empty' };
      }

      const eligibility = request.preflight?.();
      if (eligibility && !eligibility.ok) {
        return {
          delivered: false,
          retryable: false,
          uncertain: false,
          reason: `dispatch-ineligible:${eligibility.reason}`,
        };
      }

      try {
        await deliverPrompt(live.tab.sessionName, request.message);
        return { delivered: true };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { delivered: false, retryable: false, uncertain: true, reason: `transport-uncertain:${detail}` };
      }
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { delivered: false, retryable: false, uncertain: false, reason: `dispatch-policy-error:${detail}` };
  }
};

export const discoverMissionControlWorkspaces = async (): Promise<IMissionDiscoveryWorkspace[]> => {
  const now = Date.now();
  const [{ workspaces }, panes] = await Promise.all([getWorkspaces(), getAllPanesInfo()]);
  const statuses = getStatusManager().getAllForClient();

  return Promise.all(workspaces.map(async (workspace): Promise<IMissionDiscoveryWorkspace> => {
    const [layout, standups] = await Promise.all([
      readLayoutFile(resolveLayoutFile(workspace.id)),
      readStandups(workspace.id),
    ]);
    const latestStandup = standups[0] ?? null;
    const latestProgressAt = latestMeaningfulStandupAt(standups);
    const layoutReadable = layout !== null;
    const tabs = layout ? collectAllTabs(layout.root).filter((tab) => isAgentPanelType(tab.panelType)) : [];

    const agents = await Promise.all(tabs.map(async (tab): Promise<IMissionAgentObservation> => {
      const provider = getProviderByPanelType(tab.panelType);
      const status = statuses[tab.id];
      const pane = panes.get(tab.sessionName);
      let alive = false;
      if (provider && pane?.pid && processMatchesPanelType(tab.panelType, pane.command)) {
        const childPids = await getChildPids(pane.pid).catch(() => []);
        alive = await provider.isAgentRunning(pane.pid, childPids).catch(() => false);
        if (alive && tab.panelType === 'codex-cli') {
          const verified = runtimeGenerationFor(tab) ? await verifyCodexActiveRuntime(tab) : null;
          alive = verified?.ok === true;
        }
      }
      return {
        tabId: tab.id,
        name: tab.name,
        providerId: provider?.id ?? status?.agentProviderId ?? 'unknown',
        sessionId: status?.agentSessionId ?? null,
        cliState: status?.cliState ?? null,
        alive,
        lastActivityAt: maxTimestamp([
          status?.lastEvent?.at,
          status?.busySince,
          status?.readyForReviewAt,
          pane?.windowActivity ? pane.windowActivity * 1_000 : null,
        ]),
      };
    }));

    const hasBusyAgent = agents.some((agent) => agent.alive && agent.cliState === 'busy');
    const hasWaitingAgent = agents.some((agent) => agent.alive && agent.cliState === 'needs-input');
    const standupIsRecent = !!latestStandup
      && isSubstantiveStandup(latestStandup)
      && latestProgressAt !== null
      && now - latestProgressAt <= RECENT_STANDUP_MS;
    const standupWait = standupIsRecent
      && (latestStandup.state === 'blocked' || latestStandup.state === 'awaiting-human');
    const activity: TMissionActivity = !layoutReadable
      ? 'unknown'
      : hasBusyAgent
        ? 'active'
        : hasWaitingAgent || standupWait
          ? 'waiting'
          : 'dormant';
    const lastActivityAt = maxTimestamp(agents.map((agent) => agent.lastActivityAt));
    const stale = agents.some((agent) => agent.alive
      && agent.cliState === 'busy'
      && agent.lastActivityAt !== null
      && now - agent.lastActivityAt > STALE_BUSY_MS);
    const evidence: IMissionEvidence = {
      source: 'harness',
      sourceId: `workspace:${workspace.id}`,
      observedAt: now,
      confidence: layoutReadable ? 'confirmed' : 'unknown',
    };

    const verifiedLiveIdentities = agents.flatMap((agent): Array<Omit<IMissionBinding, 'generation'>> => {
      if (!agent.alive || !agent.sessionId || agent.providerId === 'unknown') return [];
      const tab = tabs.find((candidate) => candidate.id === agent.tabId);
      const provider = getProviderByPanelType(tab?.panelType);
      const status = statuses[agent.tabId];
      if (!tab || !provider || status?.workspaceId !== workspace.id || status.agentProviderId !== provider.id
        || !provider.isValidSessionId(agent.sessionId)) return [];
      return [missionIdentityFor(tab, provider.id, agent.sessionId)];
    });
    const lifecycleIdentities = normalizeMissionIdentities(verifiedLiveIdentities);
    const liveRunSourceKey = missionLiveRunSourceKey(workspace.id, lifecycleIdentities);
    const useStandupForRun = latestStandup !== null && standupIsRecent;
    const shouldCreateRun = liveRunSourceKey !== null || useStandupForRun;
    const standupEvidenceAt = latestProgressAt ?? latestStandup?.at ?? null;
    const runEvidence: IMissionEvidence = useStandupForRun && latestStandup && standupEvidenceAt !== null
      ? {
          source: 'standup',
          sourceId: `standup:${workspace.id}:${standupEvidenceAt}`,
          observedAt: standupEvidenceAt,
          confidence: 'provisional',
        }
      : {
          source: 'bootstrap',
          sourceId: liveRunSourceKey ?? `bootstrap:${workspace.id}:unknown`,
          observedAt: now,
          confidence: 'unknown',
        };
    const runSourceKey = useStandupForRun
      ? `workspace:${workspace.id}:standup:${standupEvidenceAt}`
      : liveRunSourceKey;
    const run: IMissionDiscoveryRun | null = shouldCreateRun && runSourceKey
      ? {
          sourceKey: runSourceKey,
          objective: useStandupForRun ? latestStandup.headline : 'Unknown current objective',
          phase: useStandupForRun ? latestStandup.state : null,
          state: activity === 'waiting' ? 'waiting' : 'running',
          nextStep: useStandupForRun ? latestStandup.next[0] ?? null : null,
          evidence: runEvidence,
          lastProgressAt: useStandupForRun ? latestProgressAt : null,
        }
      : null;

    const candidates: IMissionDiscoveryCandidate[] = (latestStandup?.blockers ?? []).map((blocker, index) => ({
      sourceKey: `workspace:${workspace.id}:standup-blocker:${stableTextKey(`${blocker.what}\n${blocker.needs}`)}`,
      question: {
        kind: 'question',
        title: blocker.what,
        context: blocker.needs,
        storyIds: [],
        options: [],
        recommendation: null,
        blockingScope: latestStandup?.state === 'blocked' ? 'run' : 'none',
        canContinue: latestStandup?.state !== 'blocked',
      },
      evidence: {
        source: 'standup',
        sourceId: `standup:${workspace.id}:${latestStandup!.at}:blocker:${index}`,
        observedAt: latestStandup!.at,
        confidence: 'provisional',
      },
    }));

    let reconciliation: IMissionDiscoveryWorkspace['reconciliation'] = null;
    const orchestratorId = workspace.orchestration?.orchestratorTabId ?? null;
    if (orchestratorId) {
      const identity = lifecycleIdentities.find((candidate) => candidate.tabId === orchestratorId);
      if (identity) {
        reconciliation = {
          sourceKey: `orchestrator:${workspace.id}:${identity.tabId}:${identity.providerId}:${identity.sessionId}:${identity.runtimeGeneration ?? ''}`,
          binding: { ...identity, generation: 0 },
        };
      }
    }

    return {
      workspaceId: workspace.id,
      name: workspace.name,
      activity,
      agents,
      identities: lifecycleIdentities,
      lastActivityAt,
      lastProgressAt: latestProgressAt,
      stale,
      evidence,
      run,
      candidates,
      reconciliation,
    };
  }));
};

const workspaceViews = async (): Promise<IMissionWorkspaceView[]> => (await discoverMissionControlWorkspaces()).map((source) => ({
  workspaceId: source.workspaceId,
  name: source.name,
  orphaned: false,
  activity: source.activity,
  agents: source.agents,
  runIds: [],
  openItems: 0,
  awaitingAcknowledgement: 0,
  lastActivityAt: source.lastActivityAt,
  lastProgressAt: source.lastProgressAt,
  stale: source.stale,
  evidence: source.evidence,
}));

const discover = async (
  bootstrapId: string,
  reconcile: boolean,
  boundarySeq: number,
): Promise<IMissionDiscoveryInput> => ({
  bootstrapId,
  reconcile,
  boundarySeq,
  observedAt: Date.now(),
  workspaces: await discoverMissionControlWorkspaces(),
});

const defaultDeps: IMissionRuntimeDeps = {
  getStore: getMissionControlStore,
  now: () => Date.now(),
  discover,
  workspaceViews,
  resolveIdentity: resolveMissionTargetIdentity,
  dispatch: dispatchMissionPrompt,
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer),
};

const deliveryMessage = (
  delivery: IMissionDelivery,
  snapshot: IMissionSnapshot,
): string | null => {
  const answer = snapshot.answers.find((candidate) => candidate.id === delivery.answerId);
  if (!answer || !delivery.binding) return null;
  const item = snapshot.items.find((candidate) => candidate.id === answer.itemId);
  if (!item) return null;
  const eventId = `mission-ack-${answer.id}`.slice(0, 128);
  return [
    `[mission-control-answer:${answer.id}] A durable human answer is waiting for item ${answer.itemId}.`,
    `Read it with: purplemux mission answers -w ${delivery.workspaceId} --run ${delivery.runId}`,
    `Acknowledge that exact answer after reading it: purplemux mission ack -w ${delivery.workspaceId} --run ${delivery.runId} --answer ${answer.id} --generation ${delivery.binding.generation} --revision ${item.revision} --event-id ${eventId} --producer-at ${answer.createdAt}`,
    'Apply the answer, then explicitly resolve or cancel the attention item with a Mission Control event. Receipt of this message does not resolve it.',
  ].join('\n');
};

const bootstrapMessage = (
  bootstrapId: string,
  entry: IMissionBootstrapEntry,
  snapshot: IMissionSnapshot,
): string => {
  const run = snapshot.runs.find((candidate) => candidate.id === entry.runId);
  const candidates = snapshot.items.filter((item) => item.runId === entry.runId && item.state === 'candidate');
  const candidateText = candidates.length > 0
    ? candidates.map((item) => `${item.id}: ${item.title}`).join('; ')
    : 'none';
  return [
    `[mission-control-bootstrap:${bootstrapId}] Reconcile the provisional snapshot for run ${entry.runId} once, during this ordinary turn.`,
    `Observed objective: ${run?.objective ?? 'unknown'}; phase: ${run?.phase ?? 'unknown'}; possible outstanding questions: ${candidateText}.`,
    `Read current state with: purplemux mission snapshot -w ${entry.workspaceId}`,
    `First bind this provisional run by emitting run.resumed for run ${entry.runId} with tabId ${entry.binding?.tabId ?? 'unknown'}, expectedRevision ${run?.revision ?? 0}, bindingGeneration 0, transferPendingAnswers false, and a unique eventId. Do not emit progress or attention events before that succeeds.`,
    'Report the current objective/epic, phase, work and worker assignments, workspace issues, completed work awaiting closeout, and next step using stable Mission Control events.',
    'After run.resumed returns the bound revision and generation, report progress with those values. Review candidates using existing authority, instructions, evidence, and delegated handling. Record routine issues for workspace handling; only explicitly escalate what the human alone must decide, approve, provide, or do. Cancel stale candidates. Historical text is not approval.',
  ].join('\n');
};

const retryOutcome = (delivery: IMissionDelivery, reason: string, now: number): IMissionDeliveryOutcome => {
  const retryIndex = Math.min(Math.max(delivery.attempts - 1, 0), RETRY_DELAYS_MS.length - 1);
  const delay = RETRY_DELAYS_MS[retryIndex];
  return { state: 'queued', nextAttemptAt: now + delay, lastError: reason };
};

export class MissionControlRuntime {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private recovered = false;

  constructor(private deps: IMissionRuntimeDeps = defaultDeps) {}

  async start(): Promise<void> {
    if (this.timer) return;
    this.deps.getStore();
    this.timer = this.deps.setInterval(() => {
      void this.tick().catch((error) => {
        log.error({ err: error }, 'Mission Control worker pass failed');
      });
    }, WORKER_INTERVAL_MS);
    await this.tick().catch((error) => {
      log.error({ err: error }, 'Mission Control unavailable during startup');
    });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      this.deps.clearInterval(this.timer);
      this.timer = null;
    }
    await this.running?.catch((error) => {
      log.error({ err: error }, 'Mission Control worker failed during shutdown');
    });
  }

  async snapshot(workspaceId?: string): Promise<IMissionSnapshot> {
    const views = await this.deps.workspaceViews();
    return this.deps.getStore().snapshot(views, workspaceId);
  }

  async bootstrap(input: { bootstrapId: string; reconcile: boolean }): Promise<IMissionBootstrap> {
    const store = this.deps.getStore();
    const boundarySeq = store.snapshot().cursor;
    const discovery = await this.deps.discover(input.bootstrapId, input.reconcile, boundarySeq);
    const result = store.reconcileDiscovery(discovery);
    void this.tick().catch((error) => {
      log.error({ err: error }, 'Mission Control post-bootstrap worker pass failed');
    });
    return result;
  }

  async tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runJobs()
      .catch((error) => {
        this.recovered = false;
        throw error;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async runJobs(): Promise<void> {
    const store = this.deps.getStore();
    if (!this.recovered) {
      store.recoverDispatching('server-restarted-during-uncertain-delivery');
      this.recovered = true;
    }
    for (const pending of store.listDueDeliveries(this.deps.now(), DELIVERY_LIMIT)) {
      await this.processDelivery(store, pending);
    }
    for (const pending of store.listQueuedBootstrapEntries(BOOTSTRAP_LIMIT)) {
      await this.processBootstrap(store, pending);
    }
  }

  private async processDelivery(store: IMissionControlRuntimeStore, pending: IMissionDelivery): Promise<void> {
    const claimed = store.claimDelivery(pending.id, pending.updatedAt);
    if (!claimed) return;
    if (!claimed.binding) {
      throw new Error(`claimed Mission Control delivery ${claimed.id} has no binding`);
    }
    const claimedBinding = claimed.binding;

    const snapshot = store.snapshot();
    const run = snapshot.runs.find((candidate) => candidate.id === claimed.runId);
    if (!run?.binding || run.binding.generation !== claimedBinding.generation) {
      store.finalizeDeliveryAttempt(claimed.id, claimed.updatedAt, claimedBinding, {
        state: 'held',
        nextAttemptAt: null,
        lastError: 'run-binding-changed',
      });
      return;
    }
    const message = deliveryMessage(claimed, snapshot);
    if (!message) {
      store.finalizeDeliveryAttempt(claimed.id, claimed.updatedAt, claimedBinding, {
        state: 'held',
        nextAttemptAt: null,
        lastError: 'delivery-records-incomplete',
      });
      return;
    }

    const result = await this.deps.dispatch({
      workspaceId: claimed.workspaceId,
      binding: claimedBinding,
      message,
      preflight: () => store.validateDeliveryAttempt(claimed.id, claimed.updatedAt, claimedBinding),
    });
    if (result.delivered) {
      store.finalizeDeliveryAttempt(claimed.id, claimed.updatedAt, claimedBinding, {
        state: 'submitted',
        nextAttemptAt: null,
        lastError: null,
        submittedAt: this.deps.now(),
      });
      return;
    }

    const outcome = result.retryable && !result.uncertain
      ? retryOutcome(claimed, result.reason, this.deps.now())
      : {
          state: 'held' as const,
          nextAttemptAt: null,
          lastError: result.reason,
        };
    store.finalizeDeliveryAttempt(claimed.id, claimed.updatedAt, claimedBinding, outcome);
  }

  private async processBootstrap(
    store: IMissionControlRuntimeStore,
    pending: IMissionBootstrapQueueEntry,
  ): Promise<void> {
    const { bootstrapId, entry } = pending;
    const claimed = store.claimBootstrapEntry(
      bootstrapId,
      entry.workspaceId,
      entry.runId,
      entry.updatedAt,
    );
    if (!claimed) return;
    const claimedEntry = claimed.entry;
    if (!claimedEntry.binding) {
      store.completeBootstrapAttempt(bootstrapId, claimedEntry.workspaceId, claimedEntry.runId, claimedEntry.updatedAt, {
        state: 'held',
        reason: 'orchestrator-binding-missing',
      });
      return;
    }

    const message = bootstrapMessage(bootstrapId, claimedEntry, store.snapshot());
    const result = await this.deps.dispatch({
      workspaceId: claimedEntry.workspaceId,
      binding: claimedEntry.binding,
      message,
      preflight: () => store.validateBootstrapAttempt(
        bootstrapId,
        claimedEntry.workspaceId,
        claimedEntry.runId,
        claimedEntry.updatedAt,
      ),
    });
    if (result.delivered) {
      store.completeBootstrapAttempt(bootstrapId, claimedEntry.workspaceId, claimedEntry.runId, claimedEntry.updatedAt, {
        state: 'submitted',
        reason: null,
      });
      return;
    }
    const delay = result.retryable && !result.uncertain
      ? RETRY_DELAYS_MS[Math.min(Math.max(claimed.attempts - 1, 0), RETRY_DELAYS_MS.length - 1)]
      : undefined;
    store.completeBootstrapAttempt(bootstrapId, claimedEntry.workspaceId, claimedEntry.runId, claimedEntry.updatedAt, {
      state: delay === undefined ? 'held' : 'queued',
      reason: delay === undefined ? result.reason : `readiness-deferred:${result.reason}`,
      nextAttemptAt: delay === undefined ? null : this.deps.now() + delay,
    });
  }
}

const g = globalThis as unknown as { __ptMissionControlRuntime?: MissionControlRuntime };

export const getMissionControlRuntime = (): MissionControlRuntime => {
  if (!g.__ptMissionControlRuntime) g.__ptMissionControlRuntime = new MissionControlRuntime();
  return g.__ptMissionControlRuntime;
};

export const getMissionSnapshot = (workspaceId?: string): Promise<IMissionSnapshot> =>
  getMissionControlRuntime().snapshot(workspaceId);

export const runMissionControlBootstrap = (input: {
  bootstrapId: string;
  reconcile: boolean;
}): Promise<IMissionBootstrap> => getMissionControlRuntime().bootstrap(input);
