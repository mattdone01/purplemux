import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBurndownRecord } from '@/types/burndown';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

const record = (workspaceId: string, receivedAt: number): IBurndownRecord => ({
  workspaceId, receivedAt,
  snapshot: { generated_at: '2026-10-09T22:36:41Z', epics: [], history: [] },
});

describe('burndown store', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-burndown-store-'));
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('reads nothing before the first publish', async () => {
    const { readBurndown } = await import('@/lib/burndown-store');
    expect(await readBurndown('ws-1')).toBeNull();
  });

  it('keeps the latest publish per workspace, private to the owner', async () => {
    const { readBurndown, writeBurndown } = await import('@/lib/burndown-store');
    await writeBurndown(record('ws-1', 1));
    await writeBurndown(record('ws-1', 2));
    await writeBurndown(record('ws-2', 3));
    expect((await readBurndown('ws-1'))?.receivedAt).toBe(2);
    expect((await readBurndown('ws-2'))?.receivedAt).toBe(3);
    const file = path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-1', 'burndown.json');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await expect(fs.access(`${file}.tmp`)).rejects.toThrow();
  });

  it('serializes concurrent publishes so the last one wins whole', async () => {
    const { readBurndown, writeBurndown } = await import('@/lib/burndown-store');
    await Promise.all(Array.from({ length: 8 }, (_, index) => writeBurndown(record('ws-1', index))));
    expect((await readBurndown('ws-1'))?.receivedAt).toBe(7);
  });

  it('reports a damaged file instead of reading it as absent', async () => {
    const { BurndownStoreError, readBurndown } = await import('@/lib/burndown-store');
    const dir = path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-1');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'burndown.json'), '{"workspaceId":"ws-1"');
    await expect(readBurndown('ws-1')).rejects.toBeInstanceOf(BurndownStoreError);
    await fs.writeFile(path.join(dir, 'burndown.json'), JSON.stringify({ ...record('ws-1', 1),
      snapshot: { generated_at: 'never', epics: [], history: [] } }));
    await expect(readBurndown('ws-1')).rejects.toThrow(/generated_at/);
    await fs.writeFile(path.join(dir, 'burndown.json'), JSON.stringify(record('ws-other', 1)));
    await expect(readBurndown('ws-1')).rejects.toThrow(/workspaceId/);
  });
});
