import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ file: '' }));
const create = vi.hoisted(() => vi.fn());
vi.mock('@/lib/layout-store', () => ({ resolveLayoutFile: () => storage.file, getLayout: create }));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: vi.fn(async () => ({ id: 'ws-foreign' })) }));

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-read-'));
  storage.file = path.join(dir, 'layout.json');
  vi.clearAllMocks();
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

describe('non-initializing workspace diagnostic reads', () => {
  it('missing foreign layout returns no tab without creating anything', async () => {
    const { findTab } = await import('@/lib/cli-utils');
    expect(await findTab('ws-foreign', 'tab-missing')).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it('invalid JSON fails unavailable without creating a backup or default session', async () => {
    await fs.writeFile(storage.file, '{broken');
    const { findTab } = await import('@/lib/cli-utils');
    await expect(findTab('ws-foreign', 'tab-missing')).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(await fs.readdir(dir)).toEqual(['layout.json']);
    expect(await fs.readFile(storage.file, 'utf-8')).toBe('{broken');
  });
  it('permission failure never becomes a missing layout or default creation', async () => {
    const { findTab } = await import('@/lib/cli-utils');
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(findTab('ws-foreign', 'tab-missing')).rejects.toThrow('denied');
    expect(create).not.toHaveBeenCalled();
  });
  it('existing layout lookup does not call initialization', async () => {
    await fs.writeFile(storage.file, JSON.stringify({ root: { type: 'pane', id: 'pane-1', tabs: [{ id: 'tab-1' }] } }));
    const { findTab } = await import('@/lib/cli-utils');
    expect(await findTab('ws-foreign', 'tab-1')).toMatchObject({ paneId: 'pane-1', tab: { id: 'tab-1' } });
    expect(create).not.toHaveBeenCalled();
  });
});
