import fs from 'fs/promises';
import { jobHoldsWork } from '@/lib/background-job-state';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { DORMANT_TICK_MS, type IDormantCandidate } from '@/lib/dormant-sweep';
import { DormantSweeper, type IDormantSweeperDeps, type IDormantWorkspace } from '@/lib/dormant-sweeper';
import { readFleetConfig, valueOf } from '@/lib/fleet-config-store';
import { listAllGrants } from '@/lib/grant-store';
import { readInboxState } from '@/lib/inbox-store';
import { collectPanes } from '@/lib/layout-tree';
import { getLedgerStore } from '@/lib/ledger-store';
import { listLeases } from '@/lib/lease-store';
import { readLivenessEvidence } from '@/lib/liveness-store';
import { createLogger } from '@/lib/logger';
import { getMissionControlStore } from '@/lib/mission-control-store';
import { readNotesState } from '@/lib/notes-store';
import { readWatches } from '@/lib/watch-store';
import type { TDormantRead } from '@/types/dormant';
import type { ILayoutData } from '@/types/terminal';

const log = createLogger('dormant-sweep');

const settle = async <T>(fn: () => Promise<T> | T): Promise<TDormantRead<T>> => {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/** Every workspace's layout on disk, read as `readLiveTabs` reads it: missing is no tabs, unreadable is unknown. */
export const listWorkspaces: IDormantSweeperDeps['listWorkspaces'] = async () => {
  const [{ readWorkspacesStrict }, { resolveLayoutFile }] = await Promise.all([
    import('@/lib/workspace-store'),
    import('@/lib/layout-store'),
  ]);
  const registry = await readWorkspacesStrict();
  const workspaces: IDormantWorkspace[] = [];
  const uncertainWorkspaceIds = new Set<string>();
  for (const ws of registry.workspaces) {
    let layout: ILayoutData;
    try {
      layout = JSON.parse(await fs.readFile(resolveLayoutFile(ws.id), 'utf-8')) as ILayoutData;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') uncertainWorkspaceIds.add(ws.id);
      continue;
    }
    const panes = collectPanes(layout.root);
    const reportsTargets = new Set(panes.flatMap((pane) => pane.tabs.map((tab) => tab.reportsTo).filter((id): id is string => !!id)));
    const tabs: IDormantCandidate[] = panes.flatMap((pane) => pane.tabs.map((tab) => ({
      workspaceId: ws.id,
      paneId: pane.id,
      tab,
      isOrchestrator: ws.orchestration?.orchestratorTabId === tab.id,
      reportsTarget: reportsTargets.has(tab.id),
    })));
    workspaces.push({ workspaceId: ws.id, tabs });
  }
  return { workspaces, uncertainWorkspaceIds };
};

/** Every grant of both stores; one refused file could hold a grant for the tab, so a partial read is no read. */
export const readAllGrants = () => {
  const all = listAllGrants();
  if (!all.ok) throw new Error(all.error);
  if (all.refused.length) throw new Error(all.refused.map((r) => `${r.file}: ${r.error}`).join('; '));
  return all.grants;
};

/**
 * The tab's registered `tab bg` jobs that hold work, failing closed (ADR-0048 §2). The store's own readers turn an
 * unreadable or malformed liveness.json into no jobs, and a hydrate that failed leaves the manager empty, so the
 * workspace's file is read strictly first: absent is no jobs, unreadable or malformed throws. A job on disk that the
 * manager does not know (its hydrate failed, or a write is in flight) holds the tab; a known one holds it while it
 * is alive or its host has not answered.
 */
export const readHeldJobs = async (workspaceId: string, tabId: string): Promise<number> => {
  const evidence = await readLivenessEvidence(workspaceId);
  if (!evidence.known) throw new Error(`liveness.json of ${workspaceId} is unreadable or malformed`);
  const { getLivenessManager } = await import('@/lib/liveness-manager');
  const known = (await getLivenessManager().statusForTab(tabId)).backgroundJobs;
  const knownPids = new Set(known.map((job) => job.pid));
  const unknown = evidence.data.jobs.filter((job) => job.tabId === tabId && !knownPids.has(job.pid)).length;
  return known.filter(jobHoldsWork).length + unknown;
};

const realDeps = (): IDormantSweeperDeps => ({
  now: () => Date.now(),
  config: async (key) => valueOf(await readFleetConfig(), key)?.value ?? null,
  listWorkspaces,
  passReads: async () => ({
    leases: await settle(() => listLeases()),
    watches: await settle(async () => (await readWatches()).watches),
    inbox: await settle(async () => (await readInboxState()).items),
    notes: await settle(async () => (await readNotesState()).notes),
    grants: await settle(readAllGrants),
  }),
  workspaceReads: (workspaceId) => {
    const sync = <T>(fn: () => T): TDormantRead<T> => {
      try {
        return { ok: true, value: fn() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };
    return {
      ledger: sync(() => getLedgerStore().tabTurns.lastActivityByTab(workspaceId)),
      missionWork: sync(() => getMissionControlStore().openWorkOfTabs(workspaceId)),
    };
  },
  status: async (tabId) => (await import('@/lib/status-manager')).getStatusManager().dormantFacts(tabId),
  pane: async (tab) => {
    const { getPaneDetailInfo } = await import('@/lib/tmux');
    const info = await getPaneDetailInfo(tab.sessionName);
    return { cwd: info.cwd, sessionCreatedAt: info.sessionCreated === null ? null : info.sessionCreated * 1000 };
  },
  jobs: readHeldJobs,
  gitFacts: async (host, cwd) => (await import('@/lib/seat-host-io')).createSeatHostIo().gitFacts(host, cwd, null),
  guard: (tabId) => statusGuard(tabId),
  close: async (workspaceId, paneId, tabId, refuseIf) => {
    const { closeTab } = await import('@/lib/layout-store');
    const result = await closeTab(workspaceId, paneId, tabId, { refuseIf });
    return { ok: result.ok, ...(result.refused ? { refused: result.refused } : {}) };
  },
  note: async (workspaceId, subject, body) => {
    const { getNotesService } = await import('@/lib/notes-service');
    await (await getNotesService()).sendSystemLocal(workspaceId, { subject, body });
  },
  audit: (entry) => appendCoordinationAudit(entry),
  log: {
    info: (line) => log.info(line),
    warn: (line) => log.warn(line),
    error: (line) => log.error(line),
  },
});

interface IDormantTick {
  timer: ReturnType<typeof setInterval> | null;
  running: Promise<unknown> | null;
  deps: IDormantSweeperDeps | null;
  guard: IDormantSweeperDeps['guard'] | null;
}

const g = globalThis as unknown as { __ptDormantTick?: IDormantTick };
if (!g.__ptDormantTick) g.__ptDormantTick = { timer: null, running: null, deps: null, guard: null };

/** The StatusManager's synchronous guard, installed by `startDormantSweep`; before that every close is refused. */
const statusGuard: IDormantSweeperDeps['guard'] = (tabId) => g.__ptDormantTick!.guard?.(tabId) ?? null;

/** The deps the running sweep uses (tests: the real adapters and the installed guard). */
export const dormantSweepDeps = (): IDormantSweeperDeps | null => g.__ptDormantTick!.deps;

/**
 * The 10-min sweep, once per process, after the StatusManager's first scan. The first pass runs one tick after boot,
 * never at boot: the hook spool and the status scan settle first, and a close needs a second pass anyway.
 */
export const startDormantSweep = async (options: { intervalMs?: number; deps?: IDormantSweeperDeps } = {}): Promise<void> => {
  const tick = g.__ptDormantTick!;
  if (tick.timer) return;
  const { getStatusManager } = await import('@/lib/status-manager');
  const manager = getStatusManager();
  tick.guard = (tabId) => manager.dormantGuard(tabId);
  const deps = options.deps ?? realDeps();
  const sweeper = new DormantSweeper(deps);
  tick.deps = deps;
  tick.timer = setInterval(() => {
    if (tick.running) return;
    tick.running = sweeper.sweep()
      .catch((err) => log.warn(`dormant sweep failed: ${err instanceof Error ? err.message : err}`))
      .finally(() => { tick.running = null; });
  }, options.intervalMs ?? DORMANT_TICK_MS);
  tick.timer.unref?.();
};

export const stopDormantSweep = async (): Promise<void> => {
  const tick = g.__ptDormantTick!;
  if (tick.timer) clearInterval(tick.timer);
  tick.timer = null;
  tick.deps = null;
  tick.guard = null;
  await tick.running?.catch(() => undefined);
};
