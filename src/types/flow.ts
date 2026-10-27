// The flow read model (ADR-0026). architecture.md §4.1 is the normative wire shape; the phone
// mirrors it in lib/core/protocol/models/flow.dart.

export type TFlowItemState = 'queued' | 'active' | 'held';

export interface IFlowItem {
  /** 1..128 characters, unique in its queue. */
  id: string;
  /** At most 120 characters. */
  label: string | null;
  since: number;
  state: TFlowItemState;
  pinned: boolean;
  /** At most 128 characters. */
  holder: string | null;
}

export interface IFlowQueue {
  /** 1..64 characters, unique among the queues. */
  name: string;
  /** An integer 1..10000. */
  capacity: number | null;
  /** At most 500. */
  items: IFlowItem[];
}

export interface IFlowLock {
  /** 1..64 characters, unique among the locks. */
  name: string;
  /** At most 128 characters; null means the lock is free. */
  heldBy: string | null;
  /** Null when the lock is free. */
  since: number | null;
}

export interface IFlowMeter {
  /** 1..64 characters, unique among the meters. */
  name: string;
  value: number;
  /** At most 16 characters. */
  unit: string;
  limit: number | null;
  /** An integer 1..10080. */
  windowMinutes: number | null;
}

export interface IFlowProducerFlag {
  /** 1..200 characters. */
  text: string;
  severity: 'info' | 'warn' | 'block';
}

/** What a producer publishes: at most 1 MiB serialized; unknown keys are refused. */
export interface IFlowSnapshot {
  schemaVersion: 1;
  generatedAt: number;
  /** 1..64 characters. */
  source: string;
  /** At most 20. */
  queues: IFlowQueue[];
  /** At most 20. */
  locks: IFlowLock[];
  /** At most 50. */
  meters: IFlowMeter[];
  /** At most 20. */
  flags: IFlowProducerFlag[];
}

/** One row per publish, derived by the server; a producer never sends history. */
export interface IFlowHistoryRow {
  at: number;
  queues: Record<string, number>;
  /** The `since` of each queue's oldest item, null for an empty queue. */
  oldest: Record<string, number | null>;
  locks: Record<string, boolean>;
  meters: Record<string, number>;
}

/** The stored record: at most 2000 history rows and 4 MiB serialized, oldest rows dropped first. */
export interface IFlowRecord {
  workspaceId: string;
  receivedAt: number;
  snapshot: IFlowSnapshot;
  history: IFlowHistoryRow[];
}

export type TFlowHistoryMode = 'all' | 'window' | 'none';

export type TFlowRule = 'lock-busy' | 'queue-long' | 'queue-old' | 'queue-full' | 'meter-over' | 'stale';

export interface IFlowDerivedFlag {
  rule: TFlowRule;
  subject: string;
  text: string;
  severity: 'warn' | 'block';
}

export interface IFlowThresholds {
  windowMinutes: number;
  lockBusyPercent: number;
  queueLength: number;
  oldestMinutes: number;
}

export interface IFlowDerived {
  flags: IFlowDerivedFlag[];
  lockBusyShare: Record<string, number | null>;
  lockKnownMinutes: Record<string, number>;
  insufficientHistory: string[];
  windowMinutes: number;
  thresholds: IFlowThresholds;
}

export interface IFlowPublishResponse {
  ok: true;
  workspaceId: string;
  receivedAt: number;
  generatedAt: number;
  historyRows: number;
  /** True when a damaged record was kept aside (a hard link) and this publish started a fresh history. */
  historyReset: boolean;
  /** The stored record, serialized. */
  bytes: number;
}

/** `GET /api/cli/workspaces/{ws}/flow`. `derived` is absent with no record, and from a server before story 02. */
export interface IFlowReadResponse {
  flow: IFlowRecord | null;
  stale: boolean | null;
  derived?: IFlowDerived;
}

export interface IMissionFlowSummary {
  workspaceId: string;
  workspaceName: string;
  receivedAt: number;
  generatedAt: number;
  source: string;
  stale: boolean;
  producerFlagCount: number;
  /** `deriveFlowFlags(...).flags.length` (story 02); an older server omits it, which means not computed, never 0 (consult C-01). */
  derivedFlagCount: number;
}

export interface IMissionFlowError {
  workspaceId: string;
  error: string;
}

/** `GET /api/mission-control/flow`: one unreadable record goes to `errors`, never blanks the list. */
export interface IMissionFlowListResponse {
  workspaces: IMissionFlowSummary[];
  errors: IMissionFlowError[];
}

/** `GET /api/mission-control/flow?workspaceId=WS`. `derived` is absent with no record, and from a server before story 02. */
export interface IMissionFlowDetailResponse {
  workspaceId: string;
  flow: IFlowRecord | null;
  stale: boolean | null;
  derived?: IFlowDerived;
}
