import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export interface IOrchestratorPresenceState {
  version: 1;
  missingWorkspaceIds: string[];
}

const g = globalThis as unknown as { __ptOrchestratorPresenceStateLock?: Promise<void> };
if (!g.__ptOrchestratorPresenceStateLock) g.__ptOrchestratorPresenceStateLock = Promise.resolve();

export const orchestratorPresenceStateFile = (): string =>
  path.join(os.homedir(), '.purplemux', 'orchestrator-presence.json');

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const previous = g.__ptOrchestratorPresenceStateLock!;
  g.__ptOrchestratorPresenceStateLock = next;
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
};

const parseState = (raw: string, file: string): IOrchestratorPresenceState => {
  const parsed = JSON.parse(raw) as Partial<IOrchestratorPresenceState> | null;
  if (parsed?.version !== 1
    || !Array.isArray(parsed.missingWorkspaceIds)
    || !parsed.missingWorkspaceIds.every((id) => typeof id === 'string' && id.length > 0)
    || new Set(parsed.missingWorkspaceIds).size !== parsed.missingWorkspaceIds.length) {
    throw new Error(`${file} is malformed; orchestrator presence notifications are paused until it is repaired or moved aside`);
  }
  return { version: 1, missingWorkspaceIds: [...parsed.missingWorkspaceIds] };
};

export const readOrchestratorPresenceState = async (): Promise<IOrchestratorPresenceState> => {
  const file = orchestratorPresenceStateFile();
  try {
    return parseState(await fs.readFile(file, 'utf-8'), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, missingWorkspaceIds: [] };
    throw error;
  }
};

const writeState = async (state: IOrchestratorPresenceState): Promise<void> => {
  const file = orchestratorPresenceStateFile();
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

export const replaceOrchestratorPresenceState = async (
  expected: ReadonlySet<string>,
  next: ReadonlySet<string>,
): Promise<boolean> => withLock(async () => {
  const current = await readOrchestratorPresenceState();
  const currentSet = new Set(current.missingWorkspaceIds);
  if (currentSet.size !== expected.size || [...currentSet].some((id) => !expected.has(id))) return false;
  const missingWorkspaceIds = [...next].sort();
  if (currentSet.size === next.size && missingWorkspaceIds.every((id) => currentSet.has(id))) return true;
  await writeState({ version: 1, missingWorkspaceIds });
  return true;
});
