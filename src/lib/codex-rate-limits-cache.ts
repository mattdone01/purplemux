import fs from 'fs/promises';
import { writeProviderRateLimitsIfNewer } from '@/lib/rate-limits-cache';
import { createLogger } from '@/lib/logger';
import type { IRateLimitsData, IRateLimitWindow } from '@/types/status';

const log = createLogger('codex-rate-limits');

const TAIL_BYTES = 1024 * 1024;
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10_080;

interface ICodexRateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
  resets_in_seconds?: number;
}

interface ICodexRateLimitsPayload {
  primary?: ICodexRateLimitWindow;
  secondary?: ICodexRateLimitWindow;
}

const toResetAt = (window: ICodexRateLimitWindow): number | null => {
  if (typeof window.resets_at === 'number' && Number.isFinite(window.resets_at)) {
    return window.resets_at;
  }
  if (typeof window.resets_in_seconds === 'number' && Number.isFinite(window.resets_in_seconds)) {
    return Math.round(Date.now() / 1000 + window.resets_in_seconds);
  }
  return null;
};

const toRateLimitWindow = (window: ICodexRateLimitWindow | undefined): IRateLimitWindow | null => {
  if (!window || typeof window.used_percent !== 'number' || !Number.isFinite(window.used_percent)) {
    return null;
  }
  const resetsAt = toResetAt(window);
  if (resetsAt === null) return null;
  return {
    used_percentage: window.used_percent,
    resets_at: resetsAt,
  };
};

const normalizeRateLimits = (rateLimits: ICodexRateLimitsPayload): IRateLimitsData | null => {
  const windows = [rateLimits.primary, rateLimits.secondary].filter(Boolean) as ICodexRateLimitWindow[];
  let fiveHour: IRateLimitWindow | null = null;
  let sevenDay: IRateLimitWindow | null = null;

  for (const window of windows) {
    const normalized = toRateLimitWindow(window);
    if (!normalized) continue;
    if (window.window_minutes === FIVE_HOUR_MINUTES) {
      fiveHour = normalized;
    } else if (window.window_minutes === SEVEN_DAY_MINUTES) {
      sevenDay = normalized;
    }
  }

  if (rateLimits.primary?.window_minutes === undefined) {
    fiveHour ??= toRateLimitWindow(rateLimits.primary);
  }
  if (rateLimits.secondary?.window_minutes === undefined) {
    sevenDay ??= toRateLimitWindow(rateLimits.secondary);
  }

  if (!fiveHour && !sevenDay) return null;
  return {
    ts: Date.now() / 1000,
    five_hour: fiveHour,
    seven_day: sevenDay,
  };
};

const extractLatestCodexRateLimits = (lines: string[]): IRateLimitsData | null => {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as {
        type?: string;
        timestamp?: string;
        payload?: {
          type?: string;
          rate_limits?: ICodexRateLimitsPayload;
        };
      };
      if (parsed.type !== 'event_msg') continue;
      if (parsed.payload?.type !== 'token_count' || !parsed.payload.rate_limits) continue;
      const timestampMs = parsed.timestamp ? Date.parse(parsed.timestamp) : NaN;
      if (!Number.isFinite(timestampMs)) continue;
      const data = normalizeRateLimits(parsed.payload.rate_limits);
      if (!data) continue;
      data.ts = timestampMs / 1000;
      return data;
    } catch {
      continue;
    }
  }
  return null;
};

export const cacheCodexRateLimitsFromJsonl = async (jsonlPath: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(jsonlPath);
    if (stat.size === 0) return false;

    const readSize = Math.min(stat.size, TAIL_BYTES);
    const handle = await fs.open(jsonlPath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, stat.size - readSize);
      const lines = buffer.toString('utf-8').split('\n').filter((line) => line.trim());
      if (stat.size > readSize && lines.length > 0) lines.shift();

      const data = extractLatestCodexRateLimits(lines);
      if (!data) return false;

      return writeProviderRateLimitsIfNewer('codex', data);
    } finally {
      await handle.close();
    }
  } catch (err) {
    log.debug({ err, jsonlPath }, 'failed to cache codex rate limits');
    return false;
  }
};

export const __testing = {
  extractLatestCodexRateLimits,
  normalizeRateLimits,
};
