import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { createLogger } from '@/lib/logger';
import { getMissionControlStore, type IMissionDeletedWorkspaceCancel, type MissionControlStore } from '@/lib/mission-control-store';
import { readWorkspaceIdsStrict } from '@/lib/workspace-store';

// Story 57: a deleted workspace leaves no item open. The delete cancels its own workspace's items; the sweep, at server
// start and on the 60 s Mission Control tick, cancels every open or candidate item whose workspace is no longer in the
// registry. One mechanism covers a delete whose own cancel failed (review r1 finding 3) and the items of workspaces
// deleted before this change (finding 2). Answered, resolved and cancelled items are never touched.

const log = createLogger('mission-control-orphan-sweep');

/** Items one sweep pass cancels at most; the next tick takes the rest. */
export const ORPHAN_SWEEP_LIMIT = 50;

export interface IOrphanSweepDeps {
  store: () => Pick<MissionControlStore, 'cancelWorkspaceItems' | 'cancelOrphanedItems'>;
  /** The registry's workspace ids, read strictly: an unreadable or unparseable registry throws. */
  workspaceIds: () => Promise<string[]>;
  audit: (entry: Record<string, unknown>) => Promise<unknown>;
  now: () => number;
}

const defaultDeps: IOrphanSweepDeps = {
  store: getMissionControlStore,
  workspaceIds: readWorkspaceIdsStrict,
  audit: appendCoordinationAudit,
  now: () => Date.now(),
};

/** The audit row of each proposal record the cancel closed, as the 60 s pass writes it. */
const auditWithdrawn = async (deps: IOrphanSweepDeps, cancel: IMissionDeletedWorkspaceCancel): Promise<void> => {
  if (!cancel.withdrawnProposals.length) return;
  // Imported here: the proposal service carries the standing-order graph, which only a withdrawal needs.
  const { auditWithdrawnProposal } = await import('@/lib/so-proposal-service');
  for (const record of cancel.withdrawnProposals) await auditWithdrawnProposal(deps.audit, record);
};

/** The delete's own cancel (story 57 AC 2): every open and candidate item of the workspace, and its proposals' audit rows. */
export const cancelDeletedWorkspace = async (workspaceId: string, deps: IOrphanSweepDeps = defaultDeps): Promise<IMissionDeletedWorkspaceCancel> => {
  const cancel = deps.store().cancelWorkspaceItems(workspaceId, deps.now());
  await auditWithdrawn(deps, cancel);
  return cancel;
};

/**
 * One bounded sweep pass. An empty registry cancels nothing: no workspace in the registry is not evidence that every
 * workspace is gone. An unreadable registry throws, and the caller logs it; the sweep never acts on what it cannot read.
 */
export const runOrphanSweep = async (deps: IOrphanSweepDeps = defaultDeps): Promise<IMissionDeletedWorkspaceCancel> => {
  const live = await deps.workspaceIds();
  if (!live.length) return { itemIds: [], withdrawnProposals: [] };
  const cancel = deps.store().cancelOrphanedItems(live, ORPHAN_SWEEP_LIMIT, deps.now());
  await auditWithdrawn(deps, cancel);
  if (cancel.itemIds.length) {
    log.info(`cancelled ${cancel.itemIds.length} open Mission Control item(s) of deleted workspaces: ${cancel.itemIds.join(', ')}`);
  }
  return cancel;
};
