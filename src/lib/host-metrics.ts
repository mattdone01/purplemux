import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { IDiskUse, THostMetrics } from '@/types/coordination';

// Host pressure for the coordination panel (story 20; NFR-7: Linux only).
// Measured 2026-09-25: the disk reached 99 % (~940 GB of worktrees) with no
// signal anywhere. `statfs` gives disk and inode use without a subprocess.

export interface IHostMetricsDeps {
  platform: string;
  statfs: (p: string) => Promise<{ bsize: number; blocks: number; bfree: number; bavail: number; files: number; ffree: number }>;
  /** The device id of the filesystem holding `p` (`stat().dev`): two paths share a filesystem when it matches. */
  deviceOf: (p: string) => Promise<number>;
  loadavg: () => number[];
  meminfo: () => Promise<string | null>;
  freemem: () => number;
  purplemuxDir: string;
}

export const defaultHostMetricsDeps = (): IHostMetricsDeps => ({
  platform: process.platform,
  statfs: (p) => fs.statfs(p),
  deviceOf: async (p) => (await fs.stat(p)).dev,
  loadavg: () => os.loadavg(),
  meminfo: () => fs.readFile('/proc/meminfo', 'utf-8').catch(() => null),
  freemem: () => os.freemem(),
  purplemuxDir: path.join(os.homedir(), '.purplemux'),
});

/** A zero total is unknown, never 0 %. */
const pct = (used: number, total: number): number | null => (total > 0 ? Math.round((used / total) * 1000) / 10 : null);

const diskOf = async (deps: IHostMetricsDeps, p: string): Promise<IDiskUse> => {
  const s = await deps.statfs(p);
  // used = total - free; the percentage `df` shows is used / (used + available to non-root).
  const used = (s.blocks - s.bfree) * s.bsize;
  const avail = s.bavail * s.bsize;
  return {
    path: p,
    usedPct: pct(used, used + avail),
    freeBytes: avail,
    inodesUsedPct: pct(s.files - s.ffree, s.files),
  };
};

export const readHostMetrics = async (deps: IHostMetricsDeps = defaultHostMetricsDeps()): Promise<THostMetrics> => {
  if (deps.platform !== 'linux') return { available: false, reason: `host metrics are Linux only (this host is ${deps.platform})` };
  const disks: IDiskUse[] = [await diskOf(deps, '/')];
  // The purplemux directory's filesystem, when it is not the root one (compared by device, not by the
  // measured values, which change between two statfs calls on a busy host).
  const [rootDev, ownDev] = await Promise.all([deps.deviceOf('/'), deps.deviceOf(deps.purplemuxDir)].map((p) => p.catch(() => null)));
  if (ownDev !== null && ownDev !== rootDev) {
    const own = await diskOf(deps, deps.purplemuxDir).catch(() => null);
    if (own) disks.push(own);
  }
  const tmp = await diskOf(deps, '/tmp').catch(() => null);
  const meminfo = await deps.meminfo();
  const avail = meminfo ? /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo)?.[1] : undefined;
  const [l1 = 0, l5 = 0, l15 = 0] = deps.loadavg();
  return {
    available: true,
    disks,
    tmpInodesUsedPct: tmp?.inodesUsedPct ?? null,
    loadAverage: [l1, l5, l15],
    memAvailableBytes: avail ? Number(avail) * 1024 : deps.freemem(),
  };
};
