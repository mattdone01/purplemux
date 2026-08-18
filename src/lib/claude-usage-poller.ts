// Claude Code's statusline payload carries only the account-wide 5h/7d
// windows. Model-scoped weekly limits (Fable has its own) live on the OAuth
// usage endpoint, so we poll it with the token Claude Code already stores and
// merge the scoped windows into the claude rate-limits entry.
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createLogger } from '@/lib/logger';
import { readRateLimitsCache, writeProviderRateLimits } from '@/lib/rate-limits-cache';
import type { IRateLimitsCache, IRateLimitsData, IScopedRateLimitWindow } from '@/types/status';

const log = createLogger('claude-usage');

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_USAGE_POLL_MS = 5 * 60_000;
const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const FETCH_TIMEOUT_MS = 10_000;

interface IUsageLimit {
  kind?: string;
  percent?: number;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

export interface IUsageResponse {
  limits?: IUsageLimit[];
}

/**
 * The scoped weekly limits from a usage response, ready for the sidebar.
 * Only `weekly_scoped` rows with a model label count; the account-wide
 * session/weekly rows are the statusline's job.
 */
export const extractScopedWindows = (body: IUsageResponse, nowMs: number): IScopedRateLimitWindow[] => {
  const out: IScopedRateLimitWindow[] = [];
  for (const limit of body.limits ?? []) {
    if (limit.kind !== 'weekly_scoped') continue;
    const label = limit.scope?.model?.display_name?.trim();
    if (!label || typeof limit.percent !== 'number') continue;
    const resetsMs = limit.resets_at ? Date.parse(limit.resets_at) : NaN;
    out.push({
      label,
      used_percentage: limit.percent,
      // A missing reset is treated as "one week from now" so the projection
      // math has something sane to work with rather than a 1970 date.
      resets_at: Math.round((Number.isFinite(resetsMs) ? resetsMs : nowMs + 7 * 86_400_000) / 1000),
    });
  }
  return out;
};

export const readOAuthAccessToken = async (): Promise<string | null> => {
  try {
    const raw = await fs.readFile(CREDENTIALS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
};

const fetchUsage = async (token: string): Promise<IUsageResponse | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      log.debug(`usage endpoint ${res.status}`);
      return null;
    }
    return (await res.json()) as IUsageResponse;
  } catch (err) {
    log.debug(`usage fetch failed: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Merge freshly fetched scoped windows into the cached claude entry. The
 * statusline keeps ownership of five_hour/seven_day; we only add `scoped`.
 * Writing goes through the same queue the statusline uses, so the two
 * writers cannot clobber each other.
 */
export const mergeScopedIntoCache = async (
  scoped: IScopedRateLimitWindow[],
  nowMs: number,
): Promise<IRateLimitsCache | null> => {
  const cache = await readRateLimitsCache();
  const current = cache.claude;
  // A fresh ts is what makes the file watcher broadcast the change; the
  // sidebar would otherwise not see a scoped update until the next statusline.
  const nextClaude: IRateLimitsData = {
    ts: nowMs / 1000,
    five_hour: current?.five_hour ?? null,
    seven_day: current?.seven_day ?? null,
    scoped,
  };
  const unchanged = current
    && JSON.stringify(current.scoped ?? []) === JSON.stringify(scoped);
  if (unchanged) return null;
  return writeProviderRateLimits('claude', nextClaude);
};

export const pollClaudeUsageOnce = async (): Promise<boolean> => {
  const token = await readOAuthAccessToken();
  if (!token) return false;
  const body = await fetchUsage(token);
  if (!body) return false;
  const scoped = extractScopedWindows(body, Date.now());
  const written = await mergeScopedIntoCache(scoped, Date.now());
  if (written) log.info({ scoped: scoped.map((s) => `${s.label}=${s.used_percentage}%`) }, 'scoped usage updated');
  return true;
};

export const createClaudeUsagePoller = () => {
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    pollClaudeUsageOnce().catch((err) => {
      log.debug(`usage poll failed: ${err instanceof Error ? err.message : err}`);
    });
  };
  return {
    start: () => {
      if (timer) return;
      tick();
      timer = setInterval(tick, CLAUDE_USAGE_POLL_MS);
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
};
