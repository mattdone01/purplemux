import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let testHome: string;

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => testHome }, homedir: () => testHome };
});

import {
  orchestratorPresenceStateFile,
  readOrchestratorPresenceState,
  replaceOrchestratorPresenceState,
} from '@/lib/orchestrator-presence-store';

beforeAll(async () => {
  testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-presence-store-'));
});

afterAll(async () => {
  await fs.rm(testHome, { recursive: true, force: true });
});

describe('orchestrator presence episode store', () => {
  it('persists a claimed missing episode and rejects a stale replacement', async () => {
    expect(await readOrchestratorPresenceState()).toEqual({ version: 1, missingWorkspaceIds: [] });
    expect(await replaceOrchestratorPresenceState(new Set(), new Set(['ws-1']))).toBe(true);
    expect(await readOrchestratorPresenceState()).toEqual({ version: 1, missingWorkspaceIds: ['ws-1'] });
    expect(await replaceOrchestratorPresenceState(new Set(), new Set(['ws-2']))).toBe(false);
    expect(await readOrchestratorPresenceState()).toEqual({ version: 1, missingWorkspaceIds: ['ws-1'] });
  });

  it('refuses malformed durable state instead of treating it as no episode', async () => {
    await fs.writeFile(orchestratorPresenceStateFile(), JSON.stringify({ version: 1, missingWorkspaceIds: [42] }));

    await expect(readOrchestratorPresenceState()).rejects.toThrow('is malformed');
  });
});
