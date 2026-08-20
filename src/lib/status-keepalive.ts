import type { IncomingMessage } from 'http';

/**
 * Per-connection keepalive profiles for the `/api/status` socket.
 *
 * Pings pace idle only — they never gate delivery. A client that asks for
 * `?keepalive=long` (the mobile alerts service, which holds the socket around
 * the clock) trades dead-connection detection latency for radio wakeups; every
 * other client, the web app included, keeps the default cadence.
 */

export const KEEPALIVE_PARAM = 'keepalive';
export const LONG_KEEPALIVE_VALUE = 'long';

export const DEFAULT_PING_INTERVAL_MS = 30_000;
export const DEFAULT_PING_TIMEOUT_MS = 90_000;
export const LONG_PING_INTERVAL_MS = 240_000;
export const LONG_PING_TIMEOUT_MS = 600_000;

export type TKeepaliveMode = 'default' | 'long';

export interface IKeepaliveProfile {
  mode: TKeepaliveMode;
  intervalMs: number;
  timeoutMs: number;
}

const DEFAULT_PROFILE: IKeepaliveProfile = Object.freeze({
  mode: 'default',
  intervalMs: DEFAULT_PING_INTERVAL_MS,
  timeoutMs: DEFAULT_PING_TIMEOUT_MS,
});

const LONG_PROFILE: IKeepaliveProfile = Object.freeze({
  mode: 'long',
  intervalMs: LONG_PING_INTERVAL_MS,
  timeoutMs: LONG_PING_TIMEOUT_MS,
});

/** Unknown and absent values fall back to the default profile (ADR-008: the client feature-detects). */
export const resolveKeepaliveProfile = (value: string | null | undefined): IKeepaliveProfile =>
  value === LONG_KEEPALIVE_VALUE ? LONG_PROFILE : DEFAULT_PROFILE;

export const keepaliveProfileFromRequest = (request?: IncomingMessage): IKeepaliveProfile => {
  if (!request?.url) return DEFAULT_PROFILE;
  try {
    const url = new URL(request.url, 'http://localhost');
    return resolveKeepaliveProfile(url.searchParams.get(KEEPALIVE_PARAM));
  } catch {
    return DEFAULT_PROFILE;
  }
};
