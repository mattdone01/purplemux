import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createLogger } from '@/lib/logger';

const log = createLogger('coordination-audit');

export const AUDIT_ROTATE_BYTES = 10 * 1024 * 1024;
export const AUDIT_KEEP = 3;

const g = globalThis as unknown as { __ptCoordinationAuditLock?: Promise<void> };
if (!g.__ptCoordinationAuditLock) g.__ptCoordinationAuditLock = Promise.resolve();

export const auditFile = (): string => path.join(os.homedir(), '.purplemux', 'audit', 'coordination.jsonl');

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__ptCoordinationAuditLock!;
  g.__ptCoordinationAuditLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

/** coordination.jsonl → .1 → … → .AUDIT_KEEP; the oldest falls off. */
const rotate = async (file: string): Promise<void> => {
  await fs.rm(`${file}.${AUDIT_KEEP}`, { force: true });
  for (let i = AUDIT_KEEP - 1; i >= 1; i--) {
    await fs.rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => {});
  }
  await fs.rename(file, `${file}.1`);
};

/**
 * One JSON line per coordination transition. An audit failure is logged, never
 * thrown: the transition it records has already happened.
 */
export const appendCoordinationAudit = (entry: Record<string, unknown>): Promise<void> =>
  withLock(async () => {
    const file = auditFile();
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const size = await fs.stat(file).then((s) => s.size).catch(() => 0);
      if (size >= AUDIT_ROTATE_BYTES) await rotate(file);
      await fs.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch (err) {
      log.warn(`coordination audit write failed: ${err instanceof Error ? err.message : err}`);
    }
  });
