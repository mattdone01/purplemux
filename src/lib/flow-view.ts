import { readFleetConfig, valueOf } from '@/lib/fleet-config-store';
import { isFlowStale, selectFlowHistory } from '@/lib/flow';
import { FLOW_CONFIG_KEYS, deriveFlowFlags, parseFlowThresholds } from '@/lib/flow-flags';
import { readFlow } from '@/lib/flow-store';
import { createLogger } from '@/lib/logger';
import type { IFlowDerived, IFlowRecord, IFlowThresholds, TFlowHistoryMode } from '@/types/flow';

// The one read service behind both flow GET routes (ADR-0026 decision 6): the record, its staleness
// and the derived flags. Flags come from the full record; only the served history is cut to the
// window, so the row that holds the lock state at the window start still counts.

const log = createLogger('flow');

const g = globalThis as unknown as { __ptFlowThresholdsLogged?: string };

export type TFlowConfigRead = (key: string) => Promise<string | null>;

/** One fleet-config read for all four keys; each key's read reports the failure itself. */
const fleetConfigReader = (): TFlowConfigRead => {
  const state = readFleetConfig();
  state.catch(() => {});
  return async (key) => valueOf(await state, key)?.value ?? null;
};

/**
 * The `flow.*` thresholds. An unset or invalid value, or an unreadable fleet config, reads as the
 * default; the reason is logged when it changes, not on every poll.
 */
export const readFlowThresholds = async (config: TFlowConfigRead = fleetConfigReader()): Promise<IFlowThresholds> => {
  const keys = Object.keys(FLOW_CONFIG_KEYS) as Array<keyof IFlowThresholds>;
  const reads = await Promise.all(keys.map(async (key) => {
    try {
      return { key, value: await config(FLOW_CONFIG_KEYS[key]), failure: null };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { key, value: null, failure: `${FLOW_CONFIG_KEYS[key]} unreadable (${why}); default` };
    }
  }));
  const raw = Object.fromEntries(reads.map((read) => [read.key, read.value]));
  const failures = reads.flatMap((read) => (read.failure ? [read.failure] : []));
  const { thresholds, reasons } = parseFlowThresholds(raw);
  const why = [...failures, ...reasons];
  const line = why.length ? `flow thresholds ${JSON.stringify(thresholds)} (${why.join('; ')})` : `flow thresholds ${JSON.stringify(thresholds)}`;
  if (g.__ptFlowThresholdsLogged !== line) {
    g.__ptFlowThresholdsLogged = line;
    if (why.length) log.warn(line);
    else log.info(line);
  }
  return thresholds;
};

export interface IFlowView {
  flow: IFlowRecord | null;
  stale: boolean | null;
  derived?: IFlowDerived;
}

/** A record as a route serves it; `derived` is absent only when there is no record. */
export const flowView = (record: IFlowRecord | null, mode: TFlowHistoryMode, thresholds: IFlowThresholds, now: number): IFlowView => {
  if (!record) return { flow: null, stale: null };
  return {
    flow: selectFlowHistory(record, mode, now, thresholds.windowMinutes),
    stale: isFlowStale(record.receivedAt, now),
    derived: deriveFlowFlags(record, thresholds, now),
  };
};

/** One workspace's flow view. A damaged record throws `FlowStoreError`, never reads as "no flow". */
export const readFlowView = async (workspaceId: string, mode: TFlowHistoryMode, now: number): Promise<IFlowView> => {
  const [record, thresholds] = await Promise.all([readFlow(workspaceId), readFlowThresholds()]);
  return flowView(record, mode, thresholds, now);
};
