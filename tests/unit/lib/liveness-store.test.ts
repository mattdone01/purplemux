import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let baseDir: string;

vi.mock('@/lib/layout-store', () => ({
  resolveLayoutDir: (wsId: string) => path.join(baseDir, wsId),
}));

import {
  readLiveness,
  upsertProbe,
  removeProbes,
  upsertJob,
  removeJobs,
  removeTabEntries,
} from '@/lib/liveness-store';
import type { IBackgroundJob, ILivenessProbe } from '@/types/liveness';

const probe = (label: string): ILivenessProbe => ({
  workspaceId: 'ws-t',
  tabId: 'tab-1',
  label,
  command: 'echo 0',
  stalenessThresholdS: 900,
  intervalS: 60,
  registeredAt: 1,
});

const job = (pid: number): IBackgroundJob => ({
  workspaceId: 'ws-t',
  tabId: 'tab-1',
  pid,
  registeredAt: 1,
});

beforeAll(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'liveness-store-'));
});

afterAll(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('liveness-store', () => {
  it('round-trips probes and jobs, upserting on the same key', async () => {
    await upsertProbe(probe('a'));
    await upsertProbe({ ...probe('a'), stalenessThresholdS: 300 });
    await upsertProbe(probe('b'));
    await upsertJob(job(10));
    await upsertJob({ ...job(10), label: 'renamed' });

    const data = await readLiveness('ws-t');
    expect(data.probes).toHaveLength(2);
    expect(data.probes.find((p) => p.label === 'a')?.stalenessThresholdS).toBe(300);
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].label).toBe('renamed');
  });

  it('removes by label / pid and reports counts', async () => {
    expect(await removeProbes('ws-t', 'tab-1', 'a')).toBe(1);
    expect(await removeJobs('ws-t', 'tab-1', 999)).toBe(0);
    expect((await readLiveness('ws-t')).probes.map((p) => p.label)).toEqual(['b']);
  });

  it('removeTabEntries clears everything for the tab', async () => {
    await removeTabEntries('ws-t', 'tab-1');
    const data = await readLiveness('ws-t');
    expect(data.probes).toEqual([]);
    expect(data.jobs).toEqual([]);
  });

  it('reads an empty file shape for an unknown workspace', async () => {
    expect(await readLiveness('ws-none')).toEqual({ probes: [], jobs: [] });
  });
});
