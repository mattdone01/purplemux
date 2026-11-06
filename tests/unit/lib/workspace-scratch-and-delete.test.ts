import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Story 57: a scratch workspace is made only at create; a workspace delete cancels its open and
// candidate Mission Control items, and a Mission Control failure never fails the delete.

const mockHome = vi.hoisted(() => ({ value: '' }));
const mission = vi.hoisted(() => ({ cancelWorkspaceItems: vi.fn() }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/tmux', () => ({ listSessions: vi.fn(async () => []), killSession: vi.fn() }));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/providers/registry', () => ({ listProviders: () => [] }));
vi.mock('@/lib/grok-home', () => ({ removeWorkspaceGrokHome: vi.fn(async () => undefined) }));
vi.mock('@/lib/workspace-home', () => ({ removeWorkspaceClaudeHome: vi.fn(async () => undefined) }));
vi.mock('@/lib/workspace-token', () => ({ revokeWorkspaceToken: vi.fn() }));
vi.mock('@/lib/tab-token', () => ({ revokeWorkspaceTabTokens: vi.fn(async () => undefined) }));
vi.mock('@/lib/layout-store', () => ({
  createDefaultLayout: vi.fn(async (workspaceId: string) => ({ version: 1, workspaceId, root: null })),
  readLayoutFile: vi.fn(async () => null),
  writeLayoutFile: vi.fn(),
  removeLayoutFile: vi.fn(async () => undefined),
  resolveLayoutDir: () => path.join(mockHome.value, '.purplemux', 'layouts'),
  resolveLayoutFile: () => path.join(mockHome.value, '.purplemux', 'layouts', 'layout.json'),
  collectAllTabs: () => [],
  updateTabAgentSessionId: vi.fn(),
}));
vi.mock('@/lib/mission-control-store', () => ({ getMissionControlStore: () => mission }));

const importStore = async () => {
  vi.resetModules();
  return import('@/lib/workspace-store');
};

beforeEach(async () => {
  vi.clearAllMocks();
  mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-ws-scratch-'));
  await fs.mkdir(path.join(mockHome.value, '.purplemux'), { recursive: true });
  mission.cancelWorkspaceItems.mockReturnValue([]);
});

describe('scratch workspaces (story 57)', () => {
  it('stores scratch: true only when the create asks for it, and keeps it across a read', async () => {
    const store = await importStore();
    const scratch = await store.createWorkspace(mockHome.value, 'acceptance-scratch-1', undefined, { scratch: true });
    const live = await store.createWorkspace(mockHome.value, 'live', undefined, {});
    expect(scratch.scratch).toBe(true);
    expect(Object.hasOwn(live, 'scratch')).toBe(false);
    expect((await store.getWorkspaceById(scratch.id))?.scratch).toBe(true);
    expect((await store.getWorkspaceById(live.id))?.scratch).toBeUndefined();
  });
});

describe('workspace delete closes its Mission Control items (story 57 AC 2)', () => {
  it('cancels the deleted workspace items after the workspace is gone', async () => {
    const store = await importStore();
    const ws = await store.createWorkspace(mockHome.value, 'acceptance-scratch-2', undefined, { scratch: true });
    mission.cancelWorkspaceItems.mockImplementation(() => ['item-1']);
    expect(await store.deleteWorkspace(ws.id)).toBe(true);
    expect(mission.cancelWorkspaceItems).toHaveBeenCalledWith(ws.id);
    expect(await store.getWorkspaceById(ws.id)).toBeUndefined();
  });

  it('still deletes the workspace when Mission Control cannot cancel its items', async () => {
    const store = await importStore();
    const ws = await store.createWorkspace(mockHome.value, 'acceptance-scratch-3', undefined, {});
    mission.cancelWorkspaceItems.mockImplementation(() => { throw new Error('storage unavailable'); });
    expect(await store.deleteWorkspace(ws.id)).toBe(true);
    expect(await store.getWorkspaceById(ws.id)).toBeUndefined();
  });

  it('cancels nothing for a workspace that does not exist', async () => {
    const store = await importStore();
    expect(await store.deleteWorkspace('ws-none')).toBe(false);
    expect(mission.cancelWorkspaceItems).not.toHaveBeenCalled();
  });
});
