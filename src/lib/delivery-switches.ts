import { readFleetConfig, valueOf } from '@/lib/fleet-config-store';

// The fleet switches of ADR-0050, admin token only (ADR-0027 ruling R2: a fleet-wide key). Each is `on` or `off`;
// unset means on.

export const TAB_SEND_QUEUE_KEY = 'tab-send.queue';
export const TAB_ADDRESS_KEY = 'tab-address';
export const TAB_ADDRESS_LEAD_PAIR_KEY = 'tab-address.lead-pair';

export const DELIVERY_SWITCH_KEYS: readonly string[] = [TAB_SEND_QUEUE_KEY, TAB_ADDRESS_KEY, TAB_ADDRESS_LEAD_PAIR_KEY];
/** A key under one of these is a delivery switch, or refused as no key. */
export const DELIVERY_SWITCH_PREFIXES: readonly string[] = ['tab-send', TAB_ADDRESS_KEY];

const readSwitch = async (key: string): Promise<boolean | null> => {
  try {
    return valueOf(await readFleetConfig(), key)?.value.trim() !== 'off';
  } catch {
    return null;
  }
};

/**
 * `tab-send.queue`. What an unreadable store reads as is the caller's: the send route reads it off (today's exit 5,
 * no new item); the dispatcher reads it on, so the messages already queued are still typed (review N7).
 */
export const messageQueueOn = async (whenUnreadable = true): Promise<boolean> => (await readSwitch(TAB_SEND_QUEUE_KEY)) ?? whenUnreadable;

/**
 * `tab-address`: off, every lookup is refused `address-disabled`. An unreadable store refuses too: an address is a
 * drive capability, and a refused seat still has `tab send`, which queues.
 */
export const addressLookupOn = async (): Promise<boolean> => (await readSwitch(TAB_ADDRESS_KEY)) ?? false;

/** `tab-address.lead-pair`: off, only the cross-workspace arm is refused (the owner's ruling of 20 Nov 2026). */
export const leadPairLookupOn = async (): Promise<boolean> => (await readSwitch(TAB_ADDRESS_LEAD_PAIR_KEY)) ?? false;
