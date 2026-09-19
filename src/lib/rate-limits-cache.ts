import fs from 'fs/promises';
import path from 'path';
import { RATE_LIMITS_FILE } from '@/lib/statusline-script';
import type { IRateLimitsCache, IRateLimitsData, TRateLimitsProvider } from '@/types/status';

const g = globalThis as unknown as { __ptRateLimitsWriteQueue?: Promise<void> };
if (!g.__ptRateLimitsWriteQueue) g.__ptRateLimitsWriteQueue = Promise.resolve();

interface IWriteResult {
  cache: IRateLimitsCache;
  written: boolean;
}

export const readRateLimitsCache = async (): Promise<Partial<IRateLimitsCache>> => {
  try {
    const raw = await fs.readFile(RATE_LIMITS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<IRateLimitsCache>;
    return {
      ...(parsed.claude ? { claude: parsed.claude } : {}),
      ...(parsed.codex ? { codex: parsed.codex } : {}),
    };
  } catch {
    return {};
  }
};

export const writeProviderRateLimits = async (
  provider: TRateLimitsProvider,
  data: IRateLimitsData,
): Promise<IRateLimitsCache> => {
  const result = await enqueueProviderRateLimits(provider, data, false);
  return result.cache;
};

const enqueueProviderRateLimits = async (
  provider: TRateLimitsProvider,
  data: IRateLimitsData,
  onlyIfNewer: boolean,
): Promise<IWriteResult> => {
  const write = async (): Promise<IWriteResult> => {
    const cache = await readRateLimitsCache();
    const current = cache[provider];
    if (onlyIfNewer && current && current.ts >= data.ts) {
      return {
        cache: { ...cache, ts: cache.ts ?? current.ts },
        written: false,
      };
    }
    // Two writers share the claude entry: the statusline hook owns the
    // account-wide windows, the usage poller owns `scoped`. Whichever writes
    // last carries the other's field forward instead of clobbering it.
    const prevScoped = cache[provider]?.scoped;
    const merged: IRateLimitsData = data.scoped === undefined && prevScoped
      ? { ...data, scoped: prevScoped }
      : data;
    const next: IRateLimitsCache = {
      ...cache,
      ts: data.ts,
      [provider]: merged,
    };
    await fs.mkdir(path.dirname(RATE_LIMITS_FILE), { recursive: true });
    await fs.writeFile(RATE_LIMITS_FILE, JSON.stringify(next));
    return { cache: next, written: true };
  };

  const result = g.__ptRateLimitsWriteQueue!.then(write, write);
  g.__ptRateLimitsWriteQueue = result.then(() => undefined, () => undefined);
  return result;
};

export const writeProviderRateLimitsIfNewer = async (
  provider: TRateLimitsProvider,
  data: IRateLimitsData,
): Promise<boolean> => {
  const result = await enqueueProviderRateLimits(provider, data, true);
  return result.written;
};
