import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let baseDir: string;

vi.mock('@/lib/layout-store', () => ({
  resolveLayoutDir: (workspaceId: string) => path.join(baseDir, workspaceId),
}));

import { readLatestStandupEvidence } from '@/lib/standup-store';

beforeAll(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'standup-evidence-'));
});

afterAll(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('latest standup evidence', () => {
  it('distinguishes no history from a structurally damaged latest report', async () => {
    expect(await readLatestStandupEvidence('ws-empty')).toEqual({ known: true, standup: null });

    const workspaceDir = path.join(baseDir, 'ws-damaged');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'standups.json'), JSON.stringify({ standups: [{}] }));

    expect(await readLatestStandupEvidence('ws-damaged')).toEqual({ known: false });
  });

  it('returns a validated latest report through the strict reader', async () => {
    const workspaceDir = path.join(baseDir, 'ws-live');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'standups.json'), JSON.stringify({
      standups: [{
        workspaceId: 'ws-live',
        at: 42,
        state: 'awaiting-human',
        headline: 'Waiting for approval',
        items: [],
        blockers: [],
        needsHuman: true,
        next: [],
      }],
    }));

    expect(await readLatestStandupEvidence('ws-live')).toMatchObject({
      known: true,
      standup: { workspaceId: 'ws-live', state: 'awaiting-human', headline: 'Waiting for approval' },
    });
  });
});
