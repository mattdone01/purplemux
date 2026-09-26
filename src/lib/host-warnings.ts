import type { THostMetrics } from '@/types/coordination';

// Warning thresholds for the coordination panel's host tiles (story 20). This
// module has no Node imports: the panel renders in the browser, and a Node-only
// module (fs, os, path) in the client bundle breaks `next build`.

export const DISK_WARN_PCT = 90;
export const INODE_WARN_PCT = 85;

/** Which tiles are in the warning state (disk ≥ 90 %, inodes ≥ 85 %). An unknown percentage never warns. */
export const hostWarnings = (host: THostMetrics): { disks: Set<string>; inodes: Set<string>; tmpInodes: boolean } => {
  const disks = new Set<string>();
  const inodes = new Set<string>();
  if (!host.available) return { disks, inodes, tmpInodes: false };
  for (const d of host.disks) {
    if (d.usedPct !== null && d.usedPct >= DISK_WARN_PCT) disks.add(d.path);
    if (d.inodesUsedPct !== null && d.inodesUsedPct >= INODE_WARN_PCT) inodes.add(d.path);
  }
  return { disks, inodes, tmpInodes: host.tmpInodesUsedPct !== null && host.tmpInodesUsedPct >= INODE_WARN_PCT };
};
