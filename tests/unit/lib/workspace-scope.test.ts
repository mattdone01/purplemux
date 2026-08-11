import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canAccessWorkspace } from '@/lib/cli-utils';
import { getWorkspaceById } from '@/lib/workspace-store';
import type { IWorkspace } from '@/types/terminal';

vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: vi.fn() }));
vi.mock('@/lib/layout-store', () => ({ getLayout: vi.fn() }));
vi.mock('@/lib/browser-bridge-client', () => ({ getBrowserBridge: vi.fn() }));

const workspace = (id: string, allowedPeers?: string[]): IWorkspace => ({
  id,
  name: id,
  directories: ['/home/mdone/code/nomupay'],
  ...(allowedPeers ? { allowedPeers } : {}),
});

describe('canAccessWorkspace', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lets the global token reach any workspace', async () => {
    vi.mocked(getWorkspaceById).mockResolvedValue(workspace('ws-other'));
    expect(await canAccessWorkspace({ type: 'admin' }, 'ws-other')).toBe(true);
  });

  it('lets a workspace-scoped caller reach its own workspace', async () => {
    expect(await canAccessWorkspace({ type: 'workspace', workspaceId: 'ws-a' }, 'ws-a')).toBe(true);
    expect(getWorkspaceById).not.toHaveBeenCalled();
  });

  it('denies a workspace-scoped caller reaching another workspace', async () => {
    vi.mocked(getWorkspaceById).mockResolvedValue(workspace('ws-b'));
    expect(await canAccessWorkspace({ type: 'workspace', workspaceId: 'ws-a' }, 'ws-b')).toBe(false);
  });

  it('allows the crossing only when the TARGET names the caller as a peer', async () => {
    vi.mocked(getWorkspaceById).mockResolvedValue(workspace('ws-b', ['ws-a']));
    expect(await canAccessWorkspace({ type: 'workspace', workspaceId: 'ws-a' }, 'ws-b')).toBe(true);
  });

  it('keeps peer grants one-directional', async () => {
    // ws-b granted ws-a; that must not also let ws-b into ws-a
    vi.mocked(getWorkspaceById).mockResolvedValue(workspace('ws-a'));
    expect(await canAccessWorkspace({ type: 'workspace', workspaceId: 'ws-b' }, 'ws-a')).toBe(false);
  });

  it('denies when the target workspace does not exist', async () => {
    vi.mocked(getWorkspaceById).mockResolvedValue(undefined);
    expect(await canAccessWorkspace({ type: 'workspace', workspaceId: 'ws-a' }, 'ws-gone')).toBe(false);
  });
});
