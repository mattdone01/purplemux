import { getMissionControlStore } from '@/lib/mission-control-store';
import { MissionControlError } from '@/lib/mission-control-errors';
import type { IHumanControlAuthority } from '@/lib/mission-control-http';
import { getNotesService } from '@/lib/notes-service';
import { readNotesState } from '@/lib/notes-store';
import { getPortfolioStore } from '@/lib/portfolio-store';
import { currentCoordinator } from '@/lib/scrum-master-access';
import { readWatches } from '@/lib/watch-store';
import { getWorkspaceById, getWorkspaces } from '@/lib/workspace-store';
import type { ICaller } from '@/lib/caller';
import type { IMissionRun } from '@/types/mission-control';
import type { IWorkspace } from '@/types/terminal';
import type { IPortfolioCoverage, IPortfolioDependency, IPortfolioImpact, IPortfolioMilestone, IPortfolioReport, IPortfolioResolution, IPortfolioSelection, IPortfolioSnapshot } from '@/types/portfolio';

/** Serialize a report advance with human note routing for the same blocker in this server. */
const impactOperations = new Map<string, Promise<void>>();
const withImpactOperation = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const previous = impactOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  impactOperations.set(key, tail);
  await previous;
  try { return await work(); }
  finally { release(); if (impactOperations.get(key) === tail) impactOperations.delete(key); }
};
const operationKey = (workspaceId: string, runId: string, sourceKey: string): string =>
  JSON.stringify([workspaceId, runId, sourceKey]);

export const portfolioProducerAuthorized = (caller: ICaller, workspaceId: string, run: IMissionRun | undefined,
  generation: number, coordinatorCurrent: boolean): boolean =>
  caller.verified && caller.workspaceId === workspaceId && !!caller.tabId && coordinatorCurrent
    && !!run && run.workspaceId === workspaceId && run.binding?.tabId === caller.tabId
    && run.binding.generation === generation && ['running', 'waiting'].includes(run.state);

export const requirePortfolioProducer = async (caller: ICaller, workspaceId: string, runId: string, generation: number): Promise<void> => {
  if (!caller.verified || caller.workspaceId !== workspaceId || !caller.tabId) {
    throw new MissionControlError(403, 'forbidden', 'Portfolio reports require the current launch-verified workspace orchestrator');
  }
  const run = getMissionControlStore().snapshot([], workspaceId).runs.find((candidate) => candidate.id === runId);
  const coordinatorCurrent = await currentCoordinator(workspaceId, caller.tabId);
  if (!portfolioProducerAuthorized(caller, workspaceId, run, generation, coordinatorCurrent)) {
    throw new MissionControlError(409, 'conflict', 'Portfolio report has a stale or unbound run generation');
  }
};

export const reportPortfolioBlocker = async (caller: ICaller, report: IPortfolioReport) => withImpactOperation(
  operationKey(report.workspaceId, report.runId, report.sourceKey), async () => {
    await requirePortfolioProducer(caller, report.workspaceId, report.runId, report.bindingGeneration);
    if (report.producerAt > Date.now() + 5 * 60_000) {
      throw new MissionControlError(400, 'invalid-request', 'producer time is in the future');
    }
    if (report.watchId) {
      const watch = (await readWatches()).watches.find((entry) => entry.id === report.watchId);
      if (!watch || report.resourceKey !== `${watch.kind}:${watch.target}`
        || (report.kind === 'ci' && (watch.kind !== 'pr' || watch.until !== 'checks-settled'))
        || (report.kind === 'lease' && (watch.kind !== 'lease' || watch.until !== 'free'))
        || (watch.kind !== 'lease' && report.watchHead !== watch.baseline)
        || (watch.kind === 'lease' && report.watchHead !== null)
        || !watch.verified) {
        throw new MissionControlError(400, 'invalid-request', 'linked watch identity or baseline does not match the dependency');
      }
    } else if (report.watchHead !== null) {
      throw new MissionControlError(400, 'invalid-request', 'watchHead requires a linked watch');
    }
    return getPortfolioStore().report(report);
  });

export const resolvePortfolioCapacity = async (caller: ICaller, event: IPortfolioResolution) => {
  await requirePortfolioProducer(caller, event.workspaceId, event.runId, event.bindingGeneration);
  const impact = getPortfolioStore().impact(event.impactId);
  if (!impact || impact.workspaceId !== event.workspaceId || impact.runId !== event.runId) {
    throw new MissionControlError(404, 'not-found', 'blocker not found in this run');
  }
  return withImpactOperation(operationKey(impact.workspaceId, impact.runId, impact.sourceKey), async () => {
    await requirePortfolioProducer(caller, event.workspaceId, event.runId, event.bindingGeneration);
    if (event.observedAt > Date.now() + 5 * 60_000) {
      throw new MissionControlError(400, 'invalid-request', 'capacity observation time is in the future');
    }
    return getPortfolioStore().resolveCapacity(event);
  });
};

export const portfolioCoverage = (
  selection: IPortfolioSelection,
  workspaces: IWorkspace[],
  managerCurrent: boolean,
  targetCurrent: ReadonlyMap<string, boolean> = new Map(),
): IPortfolioCoverage[] => {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  return selection.workspaceIds.map((workspaceId) => {
    const workspace = byId.get(workspaceId);
    const access = !workspace ? 'workspace-missing'
      : !managerCurrent || !workspace.orchestration?.enabled || !workspace.orchestration.orchestratorTabId
        || targetCurrent.get(workspaceId) === false ? 'coordinator-missing' : 'available';
    return { workspaceId, name: access === 'available' ? workspace!.name : workspaceId, access };
  });
};

const coverageFor = async (selection: IPortfolioSelection): Promise<IPortfolioCoverage[]> => {
  const { workspaces } = await getWorkspaces();
  const managerCurrent = await currentCoordinator(selection.managerWorkspaceId, selection.managerTabId);
  const targetCurrent = new Map(await Promise.all(selection.workspaceIds.map(async (workspaceId) => {
    const workspace = workspaces.find((entry) => entry.id === workspaceId);
    const tabId = workspace?.orchestration?.orchestratorTabId;
    return [workspaceId, !!tabId && await currentCoordinator(workspaceId, tabId)] as const;
  })));
  const saved = getPortfolioStore().currentSelection()?.selection;
  if (!saved || saved.managerWorkspaceId !== selection.managerWorkspaceId || saved.managerTabId !== selection.managerTabId
    || selection.workspaceIds.some((id) => id !== selection.managerWorkspaceId && !saved.workspaceIds.includes(id))) {
    throw new MissionControlError(403, 'forbidden', 'Workspace is outside the current Scrum Master scope');
  }
  return portfolioCoverage(selection, workspaces, managerCurrent, targetCurrent);
};

export const requirePortfolioCoverage = async (workspaceId: string): Promise<IPortfolioSelection> => {
  const selection = getPortfolioStore().currentSelection()?.selection;
  if (!selection || !selection.workspaceIds.includes(workspaceId)) {
    throw new MissionControlError(403, 'forbidden', 'Workspace is not in the selected management scope');
  }
  const coverage = await coverageFor(selection);
  if (coverage.find((entry) => entry.workspaceId === workspaceId)?.access !== 'available') {
    throw new MissionControlError(403, 'forbidden', 'Workspace requires a current coordinator in the Scrum Master scope');
  }
  return selection;
};

export const selectPortfolioScope = async (actor: string, selection: IPortfolioSelection): Promise<void> => {
  if (!(await currentCoordinator(selection.managerWorkspaceId, selection.managerTabId))) {
    throw new MissionControlError(409, 'conflict', 'Select a current launch-verified orchestrator tab');
  }
  getPortfolioStore().select(actor, selection);
};

export const getPortfolioSnapshot = async (): Promise<IPortfolioSnapshot> => {
  const selection = getPortfolioStore().currentSelection()?.selection;
  if (!selection) return { selection: null, coverage: [], dependencies: [], actions: [], milestones: [], generatedAt: Date.now() };
  return getPortfolioSnapshotForSelection(selection);
};

export const portfolioVisibleDependencies = (
  impacts: IPortfolioImpact[], coverage: IPortfolioCoverage[],
  notes: ReadonlyMap<string, { state: string; deliveredAt: number | null }>,
): IPortfolioDependency[] => {
  const allowed = new Set(coverage.filter((entry) => entry.access === 'available').map((entry) => entry.workspaceId));
  const grouped = new Map<string, IPortfolioDependency>();
  for (const impact of impacts) {
    if (!allowed.has(impact.workspaceId)) continue;
    const note = impact.noteId ? notes.get(impact.noteId) : undefined;
    const enriched = { ...impact, noteState: note?.state ?? null, noteDeliveredAt: note?.deliveredAt ?? null };
    const existing = grouped.get(impact.resourceKey);
    if (existing) {
      existing.impacts.push(enriched);
      existing.firstBlockedAt = Math.min(existing.firstBlockedAt, impact.firstBlockedAt);
    } else grouped.set(impact.resourceKey, {
      resourceKey: impact.resourceKey, kind: impact.kind, firstBlockedAt: impact.firstBlockedAt, impacts: [enriched],
    });
  }
  return [...grouped.values()];
};

export const getPortfolioSnapshotForSelection = async (selection: IPortfolioSelection): Promise<IPortfolioSnapshot> => {
  const coverage = await coverageFor(selection);
  const impacts = getPortfolioStore().impacts();
  const notes = new Map((await readNotesState()).notes.map((note) => [note.id, note]));
  const dependencies = portfolioVisibleDependencies(impacts, coverage, notes);
  const visibleIds = new Set(dependencies.flatMap((dependency) => dependency.impacts.map((impact) => impact.id)));
  const actions = getPortfolioStore().actions().filter((action) => visibleIds.has(action.impactId));
  const allowed = new Set(coverage.filter((entry) => entry.access === 'available').map((entry) => entry.workspaceId));
  const milestones = getPortfolioStore().milestones().filter((entry) => allowed.has(entry.workspaceId));
  const saved = getPortfolioStore().currentSelection()?.selection;
  if (!saved || saved.managerWorkspaceId !== selection.managerWorkspaceId || saved.managerTabId !== selection.managerTabId
    || selection.workspaceIds.some((id) => id !== selection.managerWorkspaceId && !saved.workspaceIds.includes(id))) {
    throw new MissionControlError(403, 'forbidden', 'Scrum Master scope changed during the read');
  }
  return { selection, coverage, dependencies, actions, milestones, generatedAt: Date.now() };
};

export const confirmPortfolioMilestone = async (authority: IHumanControlAuthority,
  event: { eventId: string; workspaceId: string; runId: string; stage: 'merged' | 'deployed' | 'verified';
    evidence: string; observedAt: number }): Promise<IPortfolioMilestone> => {
  if (authority.kind !== 'human-control' || !authority.actor) {
    throw new MissionControlError(403, 'forbidden', 'Authenticated human control required');
  }
  await requirePortfolioCoverage(event.workspaceId);
  if (event.observedAt > Date.now() + 5 * 60_000) {
    throw new MissionControlError(400, 'invalid-request', 'milestone time is in the future');
  }
  return getPortfolioStore().confirmMilestone(event, authority.actor);
};

export const assignPortfolioAction = async (
  authority: IHumanControlAuthority,
  input: { actionId: string; workspaceId: string; impactId: string; expectedRevision: number; decision: string },
) => {
  if (authority.kind !== 'human-control' || !authority.actor) {
    throw new MissionControlError(403, 'forbidden', 'Authenticated human control required');
  }
  const actor = authority.actor;
  const store = getPortfolioStore();
  await requirePortfolioCoverage(input.workspaceId);
  const impact = store.impact(input.impactId);
  if (!impact || impact.workspaceId !== input.workspaceId) {
    throw new MissionControlError(404, 'not-found', 'blocker not found in selected workspace');
  }
  return withImpactOperation(operationKey(impact.workspaceId, impact.runId, impact.sourceKey), async () => {
    await requirePortfolioCoverage(impact.workspaceId);
    const reserved = store.reserveAction(input.actionId, input.impactId, input.expectedRevision, input.decision, actor);
    if (reserved.state === 'superseded') throw new MissionControlError(409, 'conflict', 'reserved action was superseded');
    if (reserved.state === 'sent') return store.impact(input.impactId)!;
    const current = store.impact(input.impactId);
    if (current?.revision !== input.expectedRevision || current.state === 'resolved') {
      throw new MissionControlError(409, 'conflict', 'blocker changed before note routing');
    }
    const alreadyRouted = (await readNotesState()).notes.find((note) => note.externalKey === `portfolio:action:${input.actionId}`);
    if (alreadyRouted) return store.completeAction(input.actionId, alreadyRouted.id);
    const beforeRoute = store.impact(input.impactId);
    if (beforeRoute?.revision !== input.expectedRevision || beforeRoute.state === 'resolved') {
      throw new MissionControlError(409, 'conflict', 'blocker changed before note routing');
    }
    const note = await (await getNotesService()).sendHumanPortfolio(
      actor, impact.workspaceId,
      { toWorkspace: impact.workspaceId, subject: `Portfolio clearing action: ${impact.resourceKey}`,
        body: `Blocker ${impact.id} (revision ${impact.revision})\nDecision by ${actor}: ${input.decision}\nNext action: ${impact.nextAction}\nCheckpoint: ${impact.checkpointAt ?? 'none'}\nReport application separately; note acknowledgement does not resolve this blocker.`,
        externalKey: `portfolio:action:${input.actionId}` },
    );
    return store.completeAction(input.actionId, note.id);
  });
};
