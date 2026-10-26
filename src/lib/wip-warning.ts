import type { IFleetWip } from '@/types/fleet-status';
import type { ITab } from '@/types/terminal';

// The human's tab create is never refused by the WIP cap; its answer carries
// `wip` so the UI can warn (ADR-0027). Client-safe: no Node import.

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** A malformed or absent `wip` (an older server) is no warning, never a warning about 0. */
export const readCreateWip = (value: unknown): IFleetWip | null => {
  if (!value || typeof value !== 'object') return null;
  const { count, cap, overCap } = value as Record<string, unknown>;
  return isCount(count) && isCount(cap) && typeof overCap === 'boolean' ? { count, cap, overCap } : null;
};

/** The tab without `wip`, so the field never reaches the layout state the client keeps. */
export const splitCreateAnswer = (answer: ITab & { wip?: unknown }): { tab: ITab; wip: IFleetWip | null } => {
  const { wip, ...tab } = answer;
  return { tab, wip: readCreateWip(wip) };
};

export const wipWarningText = (template: string, wip: IFleetWip): string | null =>
  wip.overCap ? template.replace('{count}', String(wip.count)).replace('{cap}', String(wip.cap)) : null;
