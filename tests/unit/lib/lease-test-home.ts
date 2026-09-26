import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export const LEASE_GLOBALS = ['__ptLeaseLock', '__ptLeaseListeners', '__ptLeaseSweeper', '__ptLeaseAgentStateSource', '__ptCoordinationAuditLock', '__ptTabLifecycle'];

export const resetLeaseGlobals = (): void => {
  const g = globalThis as Record<string, unknown>;
  for (const key of LEASE_GLOBALS) delete g[key];
};

export const drainLeaseLocks = async (): Promise<void> => {
  const g = globalThis as { __ptLeaseLock?: Promise<void>; __ptCoordinationAuditLock?: Promise<void> };
  await g.__ptLeaseLock;
  await g.__ptCoordinationAuditLock;
};

export const readAudit = async (home: string): Promise<Record<string, unknown>[]> => {
  const raw = await fs.readFile(path.join(home, '.purplemux', 'audit', 'coordination.jsonl'), 'utf-8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
};

export const makeHome = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'pmux-lease-'));
