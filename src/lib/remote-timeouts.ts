import { readFleetConfig, valueOf } from '@/lib/fleet-config-store';
import { createLogger } from '@/lib/logger';
import type { IFleetConfigState } from '@/types/fleet-config';

const log = createLogger('remote');

/**
 * The ssh budget of one tmux call or host check on a remote host (ADR-0022 §5, vel-D61). Fleet-wide, or for one
 * host with `remote.timeout-ms.<host>`, which wins. Every other remote budget (create, close, transcript, spool,
 * job probe) and ssh's ConnectTimeout scale by the same ratio to the 5 s default, so unset changes nothing.
 */
export const REMOTE_TIMEOUT_KEY = 'remote.timeout-ms';
export const REMOTE_TIMEOUT_DEFAULT_MS = 5_000;
export const REMOTE_TIMEOUT_MAX_MS = 120_000;
/** ADR-0022 §5's ConnectTimeout, in seconds, at the default budget. */
export const SSH_CONNECT_TIMEOUT_S = 5;

export const remoteTimeoutKeyFor = (host: string): string => `${REMOTE_TIMEOUT_KEY}.${host}`;

/** Whole milliseconds from the default (the floor) to the maximum, or null. */
export const parseRemoteTimeoutMs = (raw: string | null | undefined): number | null => {
  const text = (raw ?? '').trim();
  if (!/^\d{4,6}$/.test(text)) return null;
  const ms = Number(text);
  return ms >= REMOTE_TIMEOUT_DEFAULT_MS && ms <= REMOTE_TIMEOUT_MAX_MS ? ms : null;
};

export const remoteTimeoutRefusal = (key: string, value: string): string | null =>
  parseRemoteTimeoutMs(value) === null
    ? `${key} must be whole milliseconds ${REMOTE_TIMEOUT_DEFAULT_MS}..${REMOTE_TIMEOUT_MAX_MS} (the ${REMOTE_TIMEOUT_DEFAULT_MS} ms default is the floor), got ${JSON.stringify(value)}`
    : null;

/** The host's budget from a read store: its own key, else the fleet key, else the default. */
export const remoteTimeoutMsIn = (state: IFleetConfigState, host: string): number =>
  parseRemoteTimeoutMs(valueOf(state, remoteTimeoutKeyFor(host))?.value)
  ?? parseRemoteTimeoutMs(valueOf(state, REMOTE_TIMEOUT_KEY)?.value)
  ?? REMOTE_TIMEOUT_DEFAULT_MS;

const UNREADABLE_WARN_GAP_MS = 60_000;
let unreadableWarnedAt = 0;

/**
 * Read at call time (ADR-0019). A store that cannot be read gives the default, never a shorter budget: the call
 * then behaves as it did before this key existed.
 */
export const remoteTimeoutMs = async (host: string): Promise<number> => {
  try {
    return remoteTimeoutMsIn(await readFleetConfig(), host);
  } catch (err) {
    if (Date.now() - unreadableWarnedAt > UNREADABLE_WARN_GAP_MS) {
      unreadableWarnedAt = Date.now();
      log.warn({ host, err: err instanceof Error ? err.message : String(err) }, 'fleet config unreadable; remote ssh budgets use the default');
    }
    return REMOTE_TIMEOUT_DEFAULT_MS;
  }
};

export interface IRemoteBudget {
  /** The call's own budget, scaled. */
  timeoutMs: number;
  connectTimeoutS: number;
}

/** A call's budget on this host: `baseMs` is its budget at the default, as the caller names it. */
export const remoteBudget = (baseMs: number, hostTimeoutMs: number): IRemoteBudget => {
  const ratio = hostTimeoutMs / REMOTE_TIMEOUT_DEFAULT_MS;
  return { timeoutMs: Math.ceil(baseMs * ratio), connectTimeoutS: Math.ceil(SSH_CONNECT_TIMEOUT_S * ratio) };
};
