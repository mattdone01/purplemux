import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;

vi.mock('@/lib/statusline-script', () => ({
  get RATE_LIMITS_FILE() { return path.join(tmpDir, 'rate-limits.json'); },
}));

import { extractScopedWindows, mergeScopedIntoCache } from '@/lib/claude-usage-poller';
import { readRateLimitsCache, writeProviderRateLimits } from '@/lib/rate-limits-cache';

const NOW = Date.UTC(2026, 7, 18, 8, 0, 0);

const usageBody = {
  five_hour: { utilization: 4, resets_at: '2026-08-18T08:50:00Z' },
  seven_day: { utilization: 69, resets_at: '2026-08-19T21:00:00Z' },
  limits: [
    { kind: 'session', group: 'session', percent: 4, resets_at: '2026-08-18T08:50:00Z', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 69, resets_at: '2026-08-19T21:00:00Z', scope: null },
    {
      kind: 'weekly_scoped', group: 'weekly', percent: 54, resets_at: '2026-08-19T21:00:00.227344+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
  ],
};

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-poller-'));
});
afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await fs.rm(path.join(tmpDir, 'rate-limits.json'), { force: true });
});

describe('extractScopedWindows', () => {
  it('keeps only model-scoped weekly limits, converting reset to epoch seconds', () => {
    const scoped = extractScopedWindows(usageBody, NOW);
    expect(scoped).toEqual([
      { label: 'Fable', used_percentage: 54, resets_at: Math.round(Date.parse('2026-08-19T21:00:00.227344+00:00') / 1000) },
    ]);
  });

  it('skips scoped rows without a label or percent, and defaults a missing reset to +7d', () => {
    const scoped = extractScopedWindows({
      limits: [
        { kind: 'weekly_scoped', percent: 10, scope: { model: { display_name: '  ' } } },
        { kind: 'weekly_scoped', scope: { model: { display_name: 'X' } } },
        { kind: 'weekly_scoped', percent: 12, resets_at: null, scope: { model: { display_name: 'Y' } } },
      ],
    }, NOW);
    expect(scoped).toEqual([{ label: 'Y', used_percentage: 12, resets_at: Math.round(NOW / 1000) + 7 * 86_400 }]);
  });

  it('returns empty for a body without limits', () => {
    expect(extractScopedWindows({}, NOW)).toEqual([]);
  });
});

describe('scoped windows survive both writers', () => {
  const claudeStatusline = { ts: 1, five_hour: { used_percentage: 4, resets_at: 100 }, seven_day: { used_percentage: 69, resets_at: 200 } };
  const fable = [{ label: 'Fable', used_percentage: 54, resets_at: 300 }];

  it('poller merge keeps the statusline windows and adds scoped', async () => {
    await writeProviderRateLimits('claude', claudeStatusline);
    const written = await mergeScopedIntoCache(fable, NOW);
    expect(written?.claude).toMatchObject({ five_hour: claudeStatusline.five_hour, seven_day: claudeStatusline.seven_day, scoped: fable });
    expect(written?.claude?.ts).toBe(NOW / 1000);
  });

  it('a later statusline write carries scoped forward instead of clobbering it', async () => {
    await writeProviderRateLimits('claude', claudeStatusline);
    await mergeScopedIntoCache(fable, NOW);
    await writeProviderRateLimits('claude', { ...claudeStatusline, ts: 2 });
    const cache = await readRateLimitsCache();
    expect(cache.claude?.scoped).toEqual(fable);
    expect(cache.claude?.ts).toBe(2);
  });

  it('an unchanged scoped set is a no-op write', async () => {
    await writeProviderRateLimits('claude', claudeStatusline);
    await mergeScopedIntoCache(fable, NOW);
    expect(await mergeScopedIntoCache(fable, NOW + 1000)).toBeNull();
  });

  it('works when the poller writes before any statusline arrived', async () => {
    const written = await mergeScopedIntoCache(fable, NOW);
    expect(written?.claude).toEqual({ ts: NOW / 1000, five_hour: null, seven_day: null, scoped: fable });
  });

  it('does not touch the codex entry', async () => {
    const codex = { ts: 5, five_hour: { used_percentage: 100, resets_at: 1 }, seven_day: null };
    await writeProviderRateLimits('codex', codex);
    await mergeScopedIntoCache(fable, NOW);
    expect((await readRateLimitsCache()).codex).toEqual(codex);
  });
});
