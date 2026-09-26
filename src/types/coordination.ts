import type { IGrant } from '@/types/grant';
import type { IInboxItem } from '@/types/inbox';
import type { ILeaseView } from '@/types/lease';
import type { INoteView } from '@/types/note';
import type { IWatchView } from '@/types/watch';

// The Mission Control coordination panel (story 20): each section is its own
// result, so one unreadable store shows its error and never blanks the others.

export type TSection<T> = { ok: true; items: T[] } | { ok: false; error: string };

export interface INoteRow extends INoteView {
  ageSeconds: number;
}

export interface IDiskUse {
  path: string;
  usedPct: number;
  freeBytes: number;
  inodesUsedPct: number | null;
}

export type THostMetrics =
  | {
    available: true;
    disks: IDiskUse[];
    /** Inode use of /tmp (a tmpfs on this host holds bulk downloads in RAM). */
    tmpInodesUsedPct: number | null;
    loadAverage: [number, number, number];
    memAvailableBytes: number;
  }
  | { available: false; reason: string };

export interface IHostSignalsValue {
  schemaVersion: number;
  stampedAt: number;
  gateSlots: { total: number; held: number; holders: Array<{ pid: number; log: string }> };
  worktrees: Array<{ repo: string; count: number; byEpic: Record<string, number> }>;
  tmpInodesPct: number;
}

export type THostSignals =
  | { state: 'not-configured' }
  | { state: 'pending' }
  | { state: 'ok'; value: IHostSignalsValue; ranAt: number; stale: boolean }
  | { state: 'error'; error: string; ranAt: number; stale: boolean };

export interface ICoordinationSnapshot {
  at: number;
  leases: TSection<ILeaseView>;
  notes: TSection<INoteRow>;
  watches: TSection<IWatchView>;
  grants: TSection<IGrant>;
  inboxHeld: TSection<IInboxItem>;
  host: THostMetrics;
  signals: THostSignals;
}
