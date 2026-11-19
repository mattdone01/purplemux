import { readFleetConfig, valueOf } from '@/lib/fleet-config-store';

// The fleet switches of ADR-0050, admin token only (ADR-0027 ruling R2: a fleet-wide key). Each is `on` or `off`;
// unset means on.

export const TAB_SEND_QUEUE_KEY = 'tab-send.queue';

export const DELIVERY_SWITCH_KEYS: readonly string[] = [TAB_SEND_QUEUE_KEY];
/** A key under one of these is a delivery switch, or refused as no key. */
export const DELIVERY_SWITCH_PREFIXES: readonly string[] = ['tab-send'];

const readSwitch = async (key: string): Promise<boolean | null> => {
  try {
    return valueOf(await readFleetConfig(), key)?.value.trim() !== 'off';
  } catch {
    return null;
  }
};

/**
 * `tab-send.queue`. An unreadable store reads on: the switch is the rollback lever, and a store nobody can read
 * would otherwise turn every busy send back into exit 5.
 */
export const messageQueueOn = async (): Promise<boolean> => (await readSwitch(TAB_SEND_QUEUE_KEY)) ?? true;
