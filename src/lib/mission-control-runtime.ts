import { createHash } from 'crypto';
import { isAgentPanelType, processMatchesPanelType } from '@/lib/agent-panel-types';
import { findTab } from '@/lib/cli-utils';
import { registerInboxPreflight, type TInboxPreflight } from '@/lib/inbox-dispatcher';
import { enqueueNotice, readInboxState, withdrawNotice, type IEnqueueRequest } from '@/lib/inbox-store';
import { collectAllTabs, readLayoutFile, resolveLayoutFile } from '@/lib/layout-store';
import { createLogger } from '@/lib/logger';
import { withOrchestrationMappingRead } from '@/lib/orchestration-mapping-lock';
import { getProviderByPanelType } from '@/lib/providers/registry';
import { verifyCodexActiveRuntime } from '@/lib/providers/codex/launch-lifecycle';
import { getChildPids } from '@/lib/process-utils';
import { readStandups } from '@/lib/standup-store';
import { getStatusManager } from '@/lib/status-manager';
import { getAllPanesInfo } from '@/lib/tmux';
import { readWorkspaceLayout } from '@/lib/workspace-layout-read';
import { getWorkspaces } from '@/lib/workspace-store';
import {
  getMissionControlStore,
  type IMissionBootstrapQueueEntry,
  type IMissionDiscoveryCandidate,
  type IMissionDiscoveryInput,
  type IMissionDiscoveryRun,
  type IMissionDiscoveryWorkspace,
  type MissionControlStore,
} from '@/lib/mission-control-store';
import type {
  IMissionAgentObservation,
  IMissionBinding,
  IMissionBootstrap,
  IMissionDelivery,
  IMissionEvent,
  IMissionEvidence,
  IMissionSnapshot,
  IMissionWorkspaceView,
  TMissionActivity,
  TMissionRebindCause,
} from '@/types/mission-control';
import type { IInboxItem } from '@/types/inbox';
import type { IWorkspaceStandup } from '@/types/status';
import type { ITab } from '@/types/terminal';

const log = createLogger('mission-control-runtime');

const DELIVERY_LIMIT = 20;
const BOOTSTRAP_LIMIT = 10;
const WORKER_INTERVAL_MS = 1_000;
const STALE_BUSY_MS = 10 * 60_000;
const RECENT_STANDUP_MS = 30 * 60_000;
const REBIND_RETRY_MS = 5_000;

export type IMissionControlRuntimeStore = Pick<MissionControlStore,
  | 'snapshot'
  | 'reconcileDiscovery'
  | 'listDueDeliveries'
  | 'claimDelivery'
  | 'claimInboxDelivery'
  | 'listInboxHandoffs'
  | 'validateDeliveryAttempt'
  | 'finalizeDeliveryAttempt'
  | 'recoverDispatching'
  | 'listOpenRunBindings'
  | 'rebindOpenRuns'
  | 'listQueuedBootstrapEntries'
  | 'claimBootstrapEntry'
  | 'validateBootstrapAttempt'
  | 'completeBootstrapAttempt'
>;

/** The configured orchestrator of a workspace and every tab its layout holds. */
export interface IMissionOrchestratorTarget {
  tabId: string;
  tabIds: string[];
}

export interface IMissionRuntimeDeps {
  getStore: () => IMissionControlRuntimeStore;
  now: () => number;
  discover: (bootstrapId: string, reconcile: boolean, boundarySeq: number) => Promise<IMissionDiscoveryInput>;
  workspaceViews: () => Promise<IMissionWorkspaceView[]>;
  resolveIdentity: (workspaceId: string, tabId: string) => Promise<Omit<IMissionBinding, 'generation'> | null>;
  /** Null without a configured orchestrator tab that a readable layout still holds. */
  orchestratorTarget: (workspaceId: string) => Promise<IMissionOrchestratorTarget | null>;
  /** Excludes an orchestrator change of the workspace while a deferred rebind reads the mapping and writes. */
  withMappingRead: <T>(workspaceId: string, work: () => Promise<T>) => Promise<T>;
  inbox: IMissionInbox;
  setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
}

/**
 * Mission Control delivers through the tab inbox (ADR-0012, story 12; consult ruling A′). While a notice
 * waits, its row is `queued` with no `next_attempt_at` and the marker `inbox:<itemId>`; the inbox's
 * paste-time preflight claims it to `dispatching`, so `dispatching` still means "a paste may be in flight".
 */
export interface IMissionInbox {
  enqueue: (request: IEnqueueRequest<'mission'>) => Promise<{ item: IInboxItem; created: boolean }>;
  items: () => Promise<IInboxItem[]>;
  withdraw: (id: string, reason: string) => Promise<boolean>;
  registerPreflight: (kind: 'mission', fn: TInboxPreflight) => () => void;
}

const INBOX_MARKER = 'inbox:';
const markerFor = (itemId: string): string => `${INBOX_MARKER}${itemId}`;
const markedItem = (marker: string | null): string | null =>
  marker?.startsWith(INBOX_MARKER) ? marker.slice(INBOX_MARKER.length) : null;

/** The server-made id a bootstrap notice carries: never the caller's bootstrap id (ADR-0012). */
export const missionBootstrapKey = (bootstrapId: string, workspaceId: string, runId: string): string =>
  `boot-${createHash('sha256').update(JSON.stringify([bootstrapId, workspaceId, runId])).digest('hex').slice(0, 32)}`;

/** A paste the preflight allowed: the claimed row and its version, keyed by inbox item id (memory only). */
type TMissionClaim =
  | { type: 'delivery'; id: string; updatedAt: number; binding: IMissionBinding }
  | { type: 'bootstrap'; bootstrapId: string; workspaceId: string; runId: string; updatedAt: number };

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

// Moved to composer-readiness (story 09); re-exported for existing importers.
export { hasEmptyAgentComposer } from '@/lib/composer-readiness';

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

export const resolveMissionOrchestratorTarget = async (workspaceId: string): Promise<IMissionOrchestratorTarget | null> => {
  const { workspaces } = await getWorkspaces();
  const tabId = workspaces.find((workspace) => workspace.id === workspaceId)?.orchestration?.orchestratorTabId;
  if (!tabId) return null;
  const layout = await readWorkspaceLayout(workspaceId).catch(() => null);
  if (!layout) return null;
  const tabIds = collectAllTabs(layout.root).map((tab) => tab.id);
  return tabIds.includes(tabId) ? { tabId, tabIds } : null;
};

const defaultDeps: IMissionRuntimeDeps = {
  getStore: getMissionControlStore,
  now: () => Date.now(),
  discover,
  workspaceViews,
  resolveIdentity: resolveMissionTargetIdentity,
  orchestratorTarget: resolveMissionOrchestratorTarget,
  withMappingRead: withOrchestrationMappingRead,
  inbox: {
    enqueue: enqueueNotice,
    items: async () => (await readInboxState()).items,
    withdraw: withdrawNotice,
    registerPreflight: registerInboxPreflight,
  },
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer),
};

const heldFromItem = (item: IInboxItem | undefined): string | null => {
  if (!item) return 'inbox-item-missing';
  if (item.state === 'held') return item.heldReason ?? 'inbox-held';
  if (item.state === 'dropped') return `inbox-dropped:${item.droppedReason ?? 'unknown'}`;
  return null;
};

export class MissionControlRuntime {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private recovered = false;
  private claims = new Map<string, TMissionClaim>();
  private unregisterPreflight: (() => void) | null = null;
  private lastInboxReadError: string | null = null;
  private stopping = false;
  private pendingRebinds = new Map<string, TMissionRebindCause>();
  private bindingsScanned = false;
  private nextRebindAttemptAt = 0;

  constructor(private deps: IMissionRuntimeDeps = defaultDeps) {}

  async start(): Promise<void> {
    if (this.timer) return;
    this.stopping = false;
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
    // No pass starts once stop has begun (a bootstrap request during shutdown would otherwise hand
    // off a row, or re-register the preflight, beside the final sync — review r2, R2-1).
    this.stopping = true;
    if (this.timer) {
      this.deps.clearInterval(this.timer);
      this.timer = null;
    }
    this.unregisterPreflight?.();
    this.unregisterPreflight = null;
    await this.running?.catch((error) => {
      log.error({ err: error }, 'Mission Control worker failed during shutdown');
    });
    // One last sync: the server stops the inbox first, so a paste it finished is settled here rather
    // than held by the next boot's recovery (review r1, N5).
    if (this.claims.size > 0) {
      await this.sync(this.deps.getStore()).catch((error) => {
        log.error({ err: error }, 'Mission Control final sync failed during shutdown');
      });
    }
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

  /**
   * The commit point of an orchestrator change. The open runs of the workspace follow the new
   * orchestrator once its live identity resolves; until then the rebind waits for the worker, and no
   * binding is written from a guess. Never throws: the mapping is already committed.
   */
  async rebindToOrchestrator(workspaceId: string, tabId: string, cause: TMissionRebindCause): Promise<IMissionEvent[]> {
    try {
      const store = this.deps.getStore();
      if (store.listOpenRunBindings(workspaceId).length === 0) {
        this.pendingRebinds.delete(workspaceId);
        return [];
      }
      const identity = await this.deps.resolveIdentity(workspaceId, tabId);
      if (!identity) {
        this.pendingRebinds.set(workspaceId, cause);
        return [];
      }
      const events = store.rebindOpenRuns({ workspaceId, identity, cause });
      this.pendingRebinds.delete(workspaceId);
      this.logRebound(workspaceId, cause, events);
      return events;
    } catch (error) {
      this.pendingRebinds.set(workspaceId, cause);
      log.error({ err: error, workspaceId, tabId, cause }, 'Mission Control rebind deferred after a failure');
      return [];
    }
  }

  private logRebound(workspaceId: string, cause: TMissionRebindCause, events: IMissionEvent[]): void {
    if (events.length === 0) return;
    log.info({ workspaceId, cause, runIds: events.map((event) => event.runId) }, 'Mission Control runs rebound to the orchestrator');
  }

  /**
   * Rebinds that could not complete at their commit point, and — once per process — the bindings an
   * earlier release or a restart left on a tab that is gone. Each waits until the configured
   * orchestrator's live identity resolves.
   */
  private async settleRebinds(store: IMissionControlRuntimeStore): Promise<void> {
    if (!this.bindingsScanned) {
      for (const run of store.listOpenRunBindings()) {
        if (!this.pendingRebinds.has(run.workspaceId)) this.pendingRebinds.set(run.workspaceId, 'heal');
      }
      this.bindingsScanned = true;
    }
    if (this.pendingRebinds.size === 0 || this.deps.now() < this.nextRebindAttemptAt) return;
    this.nextRebindAttemptAt = this.deps.now() + REBIND_RETRY_MS;
    for (const workspaceId of [...this.pendingRebinds.keys()]) {
      await this.deps.withMappingRead(workspaceId, async () => {
        const cause = this.pendingRebinds.get(workspaceId);
        if (cause && await this.settleRebind(store, workspaceId, cause)) this.pendingRebinds.delete(workspaceId);
      });
    }
  }

  /** True when nothing is left to wait for: the runs were rebound, or there is nothing to bind or to bind to. */
  private async settleRebind(store: IMissionControlRuntimeStore, workspaceId: string, cause: TMissionRebindCause): Promise<boolean> {
    const target = await this.deps.orchestratorTarget(workspaceId);
    if (!target) return true;
    // A heal moves a binding only off a tab that left the workspace: a run a live sibling tab holds stays.
    const eligible = cause === 'heal'
      ? (binding: IMissionBinding) => binding.tabId !== target.tabId && !target.tabIds.includes(binding.tabId)
      : undefined;
    if (!store.listOpenRunBindings(workspaceId).some((run) => !eligible || eligible(run.binding))) return true;
    const identity = await this.deps.resolveIdentity(workspaceId, target.tabId);
    if (!identity) return false;
    this.logRebound(workspaceId, cause, store.rebindOpenRuns({ workspaceId, identity, cause, eligible }));
    return true;
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.running) return this.running;
    this.running = this.runJobs().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runJobs(): Promise<void> {
    const store = this.deps.getStore();
    // Once per process, before the preflight is registered: a `dispatching` row left by the previous
    // process may be a paste that happened. Only a failed recovery re-arms it — pastes now run in the
    // inbox's own tick, so a mid-run recovery could hold a row in the middle of one (ruling A′ §6).
    if (!this.recovered) {
      store.recoverDispatching('server-restarted-during-uncertain-delivery');
      this.recovered = true;
    }
    // Contained: deliveries never wait on a workspace whose orchestrator cannot be read.
    await this.settleRebinds(store).catch((error) => {
      log.error({ err: error }, 'Mission Control rebind pass failed');
    });
    this.unregisterPreflight ??= this.deps.inbox.registerPreflight('mission', (item) => this.preflight(item));
    // An unreadable inbox skips the whole pass: a handoff would only fail to enqueue and hold the row.
    if (!await this.sync(store)) return;
    for (const pending of store.listDueDeliveries(this.deps.now(), DELIVERY_LIMIT)) {
      await this.handOffDelivery(store, pending);
    }
    for (const pending of store.listQueuedBootstrapEntries(BOOTSTRAP_LIMIT)) {
      await this.handOffBootstrap(store, pending);
    }
  }

  /** Claim a due answer delivery, queue its one-line notice, and leave the row waiting on the item. */
  private async handOffDelivery(store: IMissionControlRuntimeStore, pending: IMissionDelivery): Promise<void> {
    const claimed = store.claimDelivery(pending.id, pending.updatedAt);
    if (!claimed) return;
    if (!claimed.binding) {
      throw new Error(`claimed Mission Control delivery ${claimed.id} has no binding`);
    }
    const claimedBinding = claimed.binding;
    const hold = (lastError: string) => {
      store.finalizeDeliveryAttempt(claimed.id, claimed.updatedAt, claimedBinding, { state: 'held', nextAttemptAt: null, lastError });
    };

    const snapshot = store.snapshot();
    const run = snapshot.runs.find((candidate) => candidate.id === claimed.runId);
    if (!run?.binding || run.binding.generation !== claimedBinding.generation) return hold('run-binding-changed');
    const answer = snapshot.answers.find((candidate) => candidate.id === claimed.answerId);
    if (!answer || !snapshot.items.some((item) => item.id === answer.itemId)) return hold('delivery-records-incomplete');
    const eligibility = store.validateDeliveryAttempt(claimed.id, claimed.updatedAt, claimedBinding);
    if (!eligibility.ok) return hold(`dispatch-ineligible:${eligibility.reason}`);

    let item: IInboxItem;
    try {
      item = await this.freshItem({
        kind: 'mission',
        targetWorkspaceId: claimed.workspaceId,
        targetTabId: claimedBinding.tabId,
        dedupeKey: `mission:delivery:${claimed.id}`,
        fields: { answerId: claimed.answerId, workspaceId: claimed.workspaceId, readyAt: answer.createdAt },
      });
    } catch (error) {
      return hold(`inbox-enqueue-failed:${error instanceof Error ? error.message : String(error)}`);
    }
    store.finalizeDeliveryAttempt(claimed.id, claimed.updatedAt, claimedBinding, {
      state: 'queued',
      nextAttemptAt: null,
      lastError: markerFor(item.id),
    });
  }

  /** Claim a queued bootstrap entry, queue its one-line notice, and leave the entry waiting on the item. */
  private async handOffBootstrap(
    store: IMissionControlRuntimeStore,
    pending: IMissionBootstrapQueueEntry,
  ): Promise<void> {
    const { bootstrapId, entry } = pending;
    const claimed = store.claimBootstrapEntry(bootstrapId, entry.workspaceId, entry.runId, entry.updatedAt);
    if (!claimed) return;
    const claimedEntry = claimed.entry;
    const complete = (outcome: { state: 'queued' | 'held'; reason: string; nextAttemptAt?: null }) =>
      store.completeBootstrapAttempt(bootstrapId, claimedEntry.workspaceId, claimedEntry.runId, claimedEntry.updatedAt, outcome);
    if (!claimedEntry.binding) {
      complete({ state: 'held', reason: 'orchestrator-binding-missing' });
      return;
    }
    const eligibility = store.validateBootstrapAttempt(bootstrapId, claimedEntry.workspaceId, claimedEntry.runId, claimedEntry.updatedAt);
    if (!eligibility.ok) {
      complete({ state: 'held', reason: `dispatch-ineligible:${eligibility.reason}` });
      return;
    }
    const key = missionBootstrapKey(bootstrapId, claimedEntry.workspaceId, claimedEntry.runId);
    let item: IInboxItem;
    try {
      item = await this.freshItem({
        kind: 'mission',
        targetWorkspaceId: claimedEntry.workspaceId,
        targetTabId: claimedEntry.binding.tabId,
        dedupeKey: `mission:bootstrap:${key}`,
        fields: { event: 'bootstrap', bootstrapKey: key, workspaceId: claimedEntry.workspaceId },
      });
    } catch (error) {
      complete({ state: 'held', reason: `inbox-enqueue-failed:${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    complete({ state: 'queued', reason: markerFor(item.id), nextAttemptAt: null });
  }

  /**
   * Queue a notice that is NEW for this handoff (review r1, N2). An item still queued under the same
   * key (a row handed off again after `run.resumed` moved it) is withdrawn first rather than reused: a
   * reused item's preflight may already be rejecting it for the row in its old state, which would leave
   * the row waiting on a dropped item. The preflight drops a withdrawn item's late attempt anyway.
   */
  private async freshItem(request: IEnqueueRequest<'mission'>): Promise<IInboxItem> {
    const first = await this.deps.inbox.enqueue(request);
    if (first.created) return first.item;
    await this.deps.inbox.withdraw(first.item.id, 'mission-rehanded');
    const second = await this.deps.inbox.enqueue(request);
    if (!second.created) throw new Error(`inbox item ${second.item.id} for ${request.dedupeKey} could not be replaced`);
    return second.item;
  }

  /**
   * The inbox's paste-time preflight (ruling A′ §4), inside the dispatch lock, just before the paste:
   * the row still waits on THIS item for THIS tab, the bound agent is the same live identity, and
   * last the row is claimed to `dispatching` and re-validated. `ok` means claimed for this paste.
   */
  async preflight(item: IInboxItem): Promise<{ ok: true } | { ok: false; reason: string }> {
    const store = this.deps.getStore();
    const marker = markerFor(item.id);
    const handoffs = store.listInboxHandoffs();
    const delivery = handoffs.deliveries.find((row) => row.state === 'queued' && row.lastError === marker);
    const boot = delivery ? undefined : handoffs.bootstrapEntries.find((row) => row.entry.state === 'queued' && row.entry.reason === marker);
    if (!delivery && !boot) return { ok: false, reason: 'mission-record-not-waiting' };
    const workspaceId = delivery?.workspaceId ?? boot!.entry.workspaceId;
    const binding = delivery ? delivery.binding : boot!.entry.binding;
    if (!binding || workspaceId !== item.targetWorkspaceId || binding.tabId !== item.targetTabId) {
      return { ok: false, reason: 'binding-tab-changed' };
    }
    const identity = await this.deps.resolveIdentity(workspaceId, binding.tabId);
    if (!identity) return { ok: false, reason: 'bound-agent-not-live' };
    if (!sameIdentity(binding, identity)) return { ok: false, reason: 'binding-identity-changed' };

    if (delivery) {
      const claimed = store.claimInboxDelivery(delivery.id, marker);
      if (!claimed?.binding) return { ok: false, reason: 'mission-record-not-waiting' };
      // Kept before anything else can throw: a claimed row is always settled by the sync (CONFIRM minor).
      this.claims.set(item.id, { type: 'delivery', id: claimed.id, updatedAt: claimed.updatedAt, binding: claimed.binding });
      const validation = store.validateDeliveryAttempt(claimed.id, claimed.updatedAt, claimed.binding);
      if (!validation.ok) {
        this.claims.delete(item.id);
        store.finalizeDeliveryAttempt(claimed.id, claimed.updatedAt, claimed.binding, {
          state: 'held', nextAttemptAt: null, lastError: `dispatch-ineligible:${validation.reason}`,
        });
        return { ok: false, reason: validation.reason };
      }
      return { ok: true };
    }
    const entry = boot!.entry;
    const claimed = store.claimBootstrapEntry(boot!.bootstrapId, entry.workspaceId, entry.runId, entry.updatedAt);
    if (!claimed) return { ok: false, reason: 'mission-record-not-waiting' };
    this.claims.set(item.id, {
      type: 'bootstrap', bootstrapId: boot!.bootstrapId, workspaceId: entry.workspaceId, runId: entry.runId, updatedAt: claimed.entry.updatedAt,
    });
    const validation = store.validateBootstrapAttempt(boot!.bootstrapId, entry.workspaceId, entry.runId, claimed.entry.updatedAt);
    if (!validation.ok) {
      this.claims.delete(item.id);
      store.completeBootstrapAttempt(boot!.bootstrapId, entry.workspaceId, entry.runId, claimed.entry.updatedAt, {
        state: 'held', reason: `dispatch-ineligible:${validation.reason}`,
      });
      return { ok: false, reason: validation.reason };
    }
    return { ok: true };
  }

  /** Map each handed-off row onto its inbox item (ruling A′ §5). False when the inbox could not be read. */
  private async sync(store: IMissionControlRuntimeStore): Promise<boolean> {
    const handoffs = store.listInboxHandoffs();
    // Read every pass, even with nothing waiting: an item whose row left the waiting state is only
    // found here (the inbox file is small; a read is one file read). An unreadable inbox skips this
    // pass, logged once per cause (review r1, N6): the rows keep waiting and nothing is typed.
    let all: IInboxItem[];
    try {
      all = await this.deps.inbox.items();
      this.lastInboxReadError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastInboxReadError) log.warn(`Mission Control inbox sync skipped: ${message}`);
      this.lastInboxReadError = message;
      return false;
    }
    const items = new Map(all.filter((item) => item.kind === 'mission').map((item) => [item.id, item]));

    // Pastes the preflight allowed: settle once the inbox recorded the outcome.
    for (const [itemId, claim] of [...this.claims]) {
      const item = items.get(itemId);
      if (item?.state === 'queued') continue; // the paste is still in flight
      this.claims.delete(itemId);
      const held = heldFromItem(item);
      if (claim.type === 'delivery') {
        store.finalizeDeliveryAttempt(claim.id, claim.updatedAt, claim.binding, held === null
          ? { state: 'submitted', nextAttemptAt: null, lastError: null, submittedAt: item?.deliveredAt ?? this.deps.now() }
          : { state: 'held', nextAttemptAt: null, lastError: held });
      } else {
        store.completeBootstrapAttempt(claim.bootstrapId, claim.workspaceId, claim.runId, claim.updatedAt, held === null
          ? { state: 'submitted', reason: null }
          : { state: 'held', reason: held });
      }
    }

    // Rows still waiting whose item ended without a paste: held, with the inbox's reason.
    for (const row of handoffs.deliveries) {
      const itemId = row.state === 'queued' ? markedItem(row.lastError) : null;
      if (!itemId) continue;
      const item = items.get(itemId);
      const held = item?.state === 'delivered' ? 'inbox-delivered-unclaimed' : heldFromItem(item);
      if (held === null) continue;
      const claimed = store.claimInboxDelivery(row.id, markerFor(itemId));
      if (claimed?.binding) {
        store.finalizeDeliveryAttempt(claimed.id, claimed.updatedAt, claimed.binding, { state: 'held', nextAttemptAt: null, lastError: held });
      }
    }
    for (const row of handoffs.bootstrapEntries) {
      const itemId = row.entry.state === 'queued' ? markedItem(row.entry.reason) : null;
      if (!itemId) continue;
      const item = items.get(itemId);
      const held = item?.state === 'delivered' ? 'inbox-delivered-unclaimed' : heldFromItem(item);
      if (held === null) continue;
      const claimed = store.claimBootstrapEntry(row.bootstrapId, row.entry.workspaceId, row.entry.runId, row.entry.updatedAt);
      if (claimed) {
        store.completeBootstrapAttempt(row.bootstrapId, row.entry.workspaceId, row.entry.runId, claimed.entry.updatedAt, { state: 'held', reason: held });
      }
    }

    // Tidiness only (the preflight is what guarantees nothing is typed): a queued item no row waits on
    // any more, whose row is known and no longer queued, is withdrawn.
    const referenced = new Set<string>([
      ...handoffs.deliveries.map((row) => markedItem(row.lastError)),
      ...handoffs.bootstrapEntries.map((row) => markedItem(row.entry.reason)),
      ...this.claims.keys(),
    ].filter((id): id is string => id !== null));
    const orphans = [...items.values()].filter((item) => item.state === 'queued' && !referenced.has(item.id));
    if (orphans.length === 0) return true;
    const snapshot = store.snapshot();
    for (const item of orphans) {
      const deliveryId = item.dedupeKey.startsWith('mission:delivery:') ? item.dedupeKey.slice('mission:delivery:'.length) : null;
      const bootKey = item.dedupeKey.startsWith('mission:bootstrap:') ? item.dedupeKey.slice('mission:bootstrap:'.length) : null;
      const row = deliveryId
        ? snapshot.deliveries.find((candidate) => candidate.id === deliveryId)
        : undefined;
      const entry = !deliveryId && bootKey && snapshot.bootstrap
        ? snapshot.bootstrap.entries.find((candidate) => missionBootstrapKey(snapshot.bootstrap!.id, candidate.workspaceId, candidate.runId) === bootKey)
        : undefined;
      const rowState = row?.state ?? entry?.state;
      const rowMarker = row ? row.lastError : entry?.reason ?? null;
      if (rowState === undefined) continue; // unknown: the preflight still refuses it at paste time
      // A row queued with no marker is about to be handed off again (a new item replaces this one);
      // a row waiting on ANOTHER item, or in any other state, leaves this one orphaned (review r1, N4).
      const waitsOn = markedItem(rowMarker);
      if (rowState === 'queued' && (waitsOn === null || waitsOn === item.id)) continue;
      await this.deps.inbox.withdraw(item.id, 'mission-record-not-waiting');
    }
    return true;
  }
}

const g = globalThis as unknown as { __ptMissionControlRuntime?: MissionControlRuntime };

export const getMissionControlRuntime = (): MissionControlRuntime => {
  if (!g.__ptMissionControlRuntime) g.__ptMissionControlRuntime = new MissionControlRuntime();
  return g.__ptMissionControlRuntime;
};

/** Called once by each committed change of a workspace's orchestrator tab. */
export const rebindMissionRunsToOrchestrator = (
  workspaceId: string,
  tabId: string,
  cause: TMissionRebindCause,
): Promise<IMissionEvent[]> => getMissionControlRuntime().rebindToOrchestrator(workspaceId, tabId, cause);

export const getMissionSnapshot = (workspaceId?: string): Promise<IMissionSnapshot> =>
  getMissionControlRuntime().snapshot(workspaceId);

export const runMissionControlBootstrap = (input: {
  bootstrapId: string;
  reconcile: boolean;
}): Promise<IMissionBootstrap> => getMissionControlRuntime().bootstrap(input);
