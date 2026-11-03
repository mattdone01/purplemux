import { LedgerStore } from '@/lib/ledger-store';
import type { TabEventsTable } from '@/lib/tab-events-store';

/** A fresh in-memory `tab_events` per manager, so no test reads another's events (ADR-0035). */
export const memoryTabEvents = (): (() => TabEventsTable) => {
  const store = new LedgerStore(':memory:');
  return () => store.tabEvents;
};
