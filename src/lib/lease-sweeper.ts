import { createLogger } from '@/lib/logger';
import { onTabClosed } from '@/lib/tab-lifecycle';
import { releaseTabLeases, sweepLeases, type IReleasedLease } from '@/lib/lease-store';
import type { TCliState } from '@/types/timeline';

const log = createLogger('lease-sweeper');

/** A crashed agent does not hold a repo for longer than this (ADR-0011). */
export const AGENT_GONE_GRACE_MS = 10 * 60 * 1000;

export interface ITabAgentState {
  cliState: TCliState;
  isAgent: boolean;
}

export interface ILeaseSweeperDeps {
  now: () => number;
  /** Tabs of every layout on disk — never the StatusManager map, which is empty until its first scan. */
  listLiveTabIds: () => Promise<ReadonlySet<string>>;
  /** null when the StatusManager does not know the tab (yet). */
  getAgentState: (tabId: string) => ITabAgentState | null;
}

export class LeaseSweeper {
  /** When each holder tab's agent was first seen inactive. In memory: after a restart the grace starts again. */
  private readonly inactiveSince = new Map<string, number>();
  private running = false;

  constructor(private readonly deps: ILeaseSweeperDeps) {}

  /** Inactive right now (for views); no grace applied. */
  isAgentInactive(tabId: string): boolean {
    const state = this.deps.getAgentState(tabId);
    return !!state && state.isAgent && state.cliState === 'inactive';
  }

  private observeAgents(liveTabIds: ReadonlySet<string>, now: number): void {
    for (const tabId of [...this.inactiveSince.keys()]) {
      if (!liveTabIds.has(tabId) || !this.isAgentInactive(tabId)) this.inactiveSince.delete(tabId);
    }
    for (const tabId of liveTabIds) {
      if (this.isAgentInactive(tabId) && !this.inactiveSince.has(tabId)) this.inactiveSince.set(tabId, now);
    }
  }

  async sweep(): Promise<IReleasedLease[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const now = this.deps.now();
      const liveTabIds = await this.deps.listLiveTabIds();
      this.observeAgents(liveTabIds, now);
      const released = await sweepLeases({
        now,
        liveTabIds,
        agentGone: (tabId) => {
          const since = this.inactiveSince.get(tabId);
          return since !== undefined && now - since >= AGENT_GONE_GRACE_MS;
        },
      });
      for (const { lease, reason } of released) log.info(`lease ${lease.name} released: ${reason}`);
      return released;
    } finally {
      this.running = false;
    }
  }

  async handleTabClosed(tabId: string): Promise<void> {
    this.inactiveSince.delete(tabId);
    const released = await releaseTabLeases(tabId, 'holder-tab-closed');
    for (const lease of released) log.info(`lease ${lease.name} released: holder-tab-closed`);
  }
}

const g = globalThis as unknown as {
  __ptLeaseSweeper?: LeaseSweeper;
  __ptLeaseAgentStateSource?: (tabId: string) => ITabAgentState | null;
};

/** The StatusManager registers itself here; until then no agent counts as gone. */
export const setLeaseAgentStateSource = (source: ((tabId: string) => ITabAgentState | null) | null): void => {
  g.__ptLeaseAgentStateSource = source ?? undefined;
};

export const getLeaseSweeper = (): LeaseSweeper => {
  if (!g.__ptLeaseSweeper) {
    const sweeper = new LeaseSweeper({
      now: () => Date.now(),
      listLiveTabIds: async () => {
        const { listLiveTabIds } = await import('@/lib/tab-lifecycle');
        return listLiveTabIds();
      },
      getAgentState: (tabId) => g.__ptLeaseAgentStateSource?.(tabId) ?? null,
    });
    g.__ptLeaseSweeper = sweeper;
    onTabClosed(({ tabId }) => {
      sweeper.handleTabClosed(tabId).catch((err) => {
        log.warn(`lease release for closed tab ${tabId} failed: ${err instanceof Error ? err.message : err}`);
      });
    });
  }
  return g.__ptLeaseSweeper;
};

/**
 * Boot: only after `getStatusManager().init()` has resolved. Tab existence
 * comes from the layouts on disk either way, but agent state must be known
 * before a sweep may call an agent gone.
 */
export const initLeases = async (): Promise<void> => {
  const released = await getLeaseSweeper().sweep();
  if (released.length) log.info(`boot lease sweep released ${released.length}: ${released.map((r) => `${r.lease.name} (${r.reason})`).join(', ')}`);
};
