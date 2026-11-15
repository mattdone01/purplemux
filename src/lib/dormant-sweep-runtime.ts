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
const listWorkspaces: IDormantSweeperDeps['listWorkspaces'] = async () => {
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

const realDeps = (): IDormantSweeperDeps => ({
  now: () => Date.now(),
  config: async (key) => valueOf(await readFleetConfig(), key)?.value ?? null,
  listWorkspaces,
  passReads: async () => ({
    leases: await settle(() => listLeases()),
    watches: await settle(async () => (await readWatches()).watches),
    inbox: await settle(async () => (await readInboxState()).items),
    notes: await settle(async () => (await readNotesState()).notes),
    // One refused grant file could hold a grant for the tab: a partial read is no read.
    grants: await settle(() => {
      const all = listAllGrants();
      if (!all.ok) throw new Error(all.error);
      if (all.refused.length) throw new Error(all.refused.map((r) => `${r.file}: ${r.error}`).join('; '));
      return all.grants;
    }),
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
  jobs: async (tabId) => {
    const { getLivenessManager } = await import('@/lib/liveness-manager');
    return (await getLivenessManager().statusForTab(tabId)).backgroundJobs.filter(jobHoldsWork).length;
  },
  gitFacts: async (host, cwd) => (await import('@/lib/seat-host-io')).createSeatHostIo().gitFacts(host, cwd, null),
  guard: () => null,
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
  sweeper: DormantSweeper | null;
}

const g = globalThis as unknown as { __ptDormantTick?: IDormantTick };
if (!g.__ptDormantTick) g.__ptDormantTick = { timer: null, running: null, sweeper: null };

/**
 * The 10-min sweep, once per process, after the StatusManager's first scan. The first pass runs one tick after boot,
 * never at boot: the hook spool and the status scan settle first, and a close needs a second pass anyway.
 */
export const startDormantSweep = async (options: { intervalMs?: number; deps?: IDormantSweeperDeps } = {}): Promise<void> => {
  const tick = g.__ptDormantTick!;
  if (tick.timer) return;
  const { getStatusManager } = await import('@/lib/status-manager');
  const deps = options.deps ?? { ...realDeps(), guard: (tabId: string) => getStatusManager().dormantGuard(tabId) };
  const sweeper = new DormantSweeper(deps);
  tick.sweeper = sweeper;
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
  tick.sweeper = null;
  await tick.running?.catch(() => undefined);
};
