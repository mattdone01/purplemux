import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITab, IWorkspace } from '@/types/terminal';

// ADR-0022, owner 16 Nov 2026: a remote tab may coordinate. The Portfolio snapshot lists this host's tmux
// only, so a remote coordinator must be asked on its host, never read as missing from that list.

const fx = vi.hoisted(() => ({ tabs: [] as ITab[], hasSession: vi.fn(async (_name: string) => true) }));
vi.mock('@/lib/layout-store', () => ({
  readLayoutFile: vi.fn(async () => ({ root: {} })),
  resolveLayoutFile: vi.fn(() => '/layout.json'),
  collectAllTabs: vi.fn(() => fx.tabs),
}));
vi.mock('@/lib/tab-token', () => ({
  getTabTokenRecord: (tabId: string) => ({ workspaceId: 'ws-a', sessionName: `session-${tabId}` }),
  tabIdentityOf: () => 'launch',
}));
vi.mock('@/lib/tmux', () => ({ hasSession: fx.hasSession }));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: vi.fn() }));
vi.mock('@/lib/portfolio-store', () => ({ getPortfolioStore: () => ({ currentSelection: () => null }) }));

const workspace = { id: 'ws-a', name: 'A', directories: [], orchestration: { enabled: true, orchestratorTabId: 'tab-c', revision: 1 } } as unknown as IWorkspace;
const tab = (host?: string): ITab => ({ id: 'tab-c', name: 'lead', sessionName: 'session-tab-c', panelType: 'claude-code', order: 0, ...(host ? { host } : {}) });

describe('current coordinator with a Portfolio snapshot', () => {
  beforeEach(() => { vi.clearAllMocks(); fx.hasSession.mockResolvedValue(true); });

  it('asks a remote coordinator on its host, not the local session list', async () => {
    fx.tabs = [tab('host-b')];
    const { currentCoordinator } = await import('@/lib/scrum-master-access');
    expect(await currentCoordinator('ws-a', 'tab-c', { workspace, liveSessions: new Set() })).toBe(true);
    expect(fx.hasSession).toHaveBeenCalledWith('session-tab-c');
    fx.hasSession.mockResolvedValue(false);
    expect(await currentCoordinator('ws-a', 'tab-c', { workspace, liveSessions: new Set() })).toBe(false);
  });

  it('reads a local coordinator from the snapshot, with no per-tab call', async () => {
    fx.tabs = [tab()];
    const { currentCoordinator } = await import('@/lib/scrum-master-access');
    expect(await currentCoordinator('ws-a', 'tab-c', { workspace, liveSessions: new Set(['session-tab-c']) })).toBe(true);
    expect(await currentCoordinator('ws-a', 'tab-c', { workspace, liveSessions: new Set() })).toBe(false);
    expect(fx.hasSession).not.toHaveBeenCalled();
  });
});
