import type { TSeatPhase } from '@/types/context-lifecycle';
import type { TCliState } from '@/types/timeline';
import type { TPanelType } from '@/types/terminal';

/** `tabs.dormant.mode` (ADR-0048). */
export type TDormantMode = 'off' | 'report' | 'close';

/** One read the sweep made: a value, or the read failed (a hold: `<source>-unreadable`). */
export type TDormantRead<T> = { ok: true; value: T } | { ok: false; error: string };

/** The transcript snapshot's part the sweep needs; `none`: the provider has no transcript handle for the tab. */
export type TDormantSnapshot =
  | { read: 'ok'; lastEntryTs: number | null; backgroundActivityAt: number | null; openBackgroundTasks: number | null; transcriptRead: boolean | null }
  | { read: 'failed'; error: string }
  | { read: 'none' };

/** What the StatusManager knows of one tab now (`StatusManager.dormantFacts`). */
export interface IDormantStatusFacts {
  cliState: TCliState;
  panelType: TPanelType | null;
  providerId: string | null;
  eventSeq: number;
  lastEventAt: number | null;
  busySince: number | null;
  lastResumeOrStartedAt: number | null;
  retired: boolean;
  restarting: boolean;
  halted: boolean;
  seatPhase: TSeatPhase | null;
  seatAdvancing: boolean;
  turnOpen: boolean;
  /** The marker of the current turn-marker stop when it is NEEDS-DECISION or BLOCKED. */
  waitingMarker: 'NEEDS-DECISION' | 'BLOCKED' | null;
  agentSessionId: string | null;
  jsonlPath: string | null;
  snapshot: TDormantSnapshot;
  /** Digest events held for the tab's next digest. */
  heldDigests: TDormantRead<number>;
  /** The newest delivery of a tab event to the tab. */
  lastDeliveredAt: TDormantRead<number | null>;
}
