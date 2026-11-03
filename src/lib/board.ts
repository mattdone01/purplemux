import { STUCK_LIMIT } from '@/lib/constraint';
import { FINDER_STALE_MS, readFinderResult } from '@/lib/constraint-tick';
import { createLogger } from '@/lib/logger';
import type { IBoard, IBoardNeedsYou } from '@/types/constraint';

const log = createLogger('board');

const readNeedsYou = async (workspaceId: string): Promise<IBoardNeedsYou[] | null> => {
  try {
    return (await import('@/lib/mission-control-store')).getMissionControlStore().openItemTitles(workspaceId);
  } catch (err) {
    log.warn({ workspaceId }, `board: Mission Control unreadable (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
};

/**
 * One workspace's board (ADR-0034): the finder's cached answer and Mission Control's open items.
 * `holders` limits the stuck list to the items those holders hold (`board show --mine`); the cap of
 * 50 oldest applies after that filter, and `stuckTotal` says how many matched.
 */
export const readBoard = async (workspaceId: string, now: number, holders: readonly string[] | null = null): Promise<IBoard> => {
  const [finder, needsYou] = await Promise.all([readFinderResult(workspaceId, now), readNeedsYou(workspaceId)]);
  const stuck = holders ? finder.stuck.filter((item) => item.holder !== null && holders.includes(item.holder)) : finder.stuck;
  const ageMs = Math.max(0, now - finder.generatedAt);
  return {
    ...finder, workspaceId, stuck: stuck.slice(0, STUCK_LIMIT), stuckTotal: stuck.length, needsYou, ageMs,
    staleSince: ageMs > FINDER_STALE_MS ? finder.generatedAt : null,
  };
};
