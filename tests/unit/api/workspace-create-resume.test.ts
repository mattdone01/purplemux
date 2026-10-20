vi.mock('@/lib/human-mutation', () => ({ authorizeHumanMutation: vi.fn(async () => true) }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import createHandler from '@/pages/api/workspace/index';
import { createWorkspace } from '@/lib/workspace-store';

// The UI create route registers the first tab AFTER it writes the resumed session id,
// so the status manager starts with the session the tab resumes (moved to
// lib/workspace-default-tab.ts by ADR-0024; the order must survive the move).

const store = vi.hoisted(() => ({ sessionId: null as string | null, registerTab: vi.fn() }));
const tab = { id: 'tab-first', sessionName: 'pt-ws-r-pane-1-tab-first', name: '', order: 0, panelType: 'claude-code' };
const provider = vi.hoisted(() => ({
  id: 'claude',
  panelType: 'claude-code',
  isValidSessionId: () => true,
  writeSessionId: vi.fn((_tab: unknown, id: string) => { store.sessionId = id; }),
  readSessionId: vi.fn(() => store.sessionId),
  buildResumeCommand: vi.fn(async () => 'claude --resume'),
}));

vi.mock('@/lib/workspace-store', () => ({ getWorkspaces: vi.fn(), createWorkspace: vi.fn() }));
vi.mock('@/lib/layout-store', () => ({
  readLayoutFile: vi.fn(async () => ({ root: {} })),
  resolveLayoutFile: vi.fn(() => '/tmp/layout.json'),
  collectAllTabs: vi.fn(() => [tab]),
  updateTabAgentSessionId: vi.fn(),
}));
vi.mock('@/lib/providers', () => ({ getProviderByPanelType: vi.fn(() => provider) }));
vi.mock('@/lib/agent-availability', () => ({
  checkAgentAvailabilityForPanelType: vi.fn(async () => ({ ok: true })),
  toAgentAvailabilityError: vi.fn(),
}));
vi.mock('@/lib/tmux', () => ({ sendKeys: vi.fn() }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ registerTab: store.registerTab, markAgentLaunch: vi.fn() }) }));

describe('POST /api/workspace with a resumed session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.sessionId = null;
    store.registerTab.mockClear();
    vi.mocked(createWorkspace).mockResolvedValue({ id: 'ws-r', name: 'r', directories: ['/srv/r'] });
  });

  it('registers the first tab with the resumed session id', async () => {
    const state = { code: 0 };
    const res = {
      status(code: number) { state.code = code; return res; },
      json() { return res; },
      setHeader() { return res; },
    } as unknown as NextApiResponse;
    await createHandler({ method: 'POST', query: {}, body: { directory: '/srv/r', resumeSessionId: 'sess-123', panelType: 'claude-code' } } as unknown as NextApiRequest, res);

    expect(state.code).toBe(200);
    expect(store.registerTab).toHaveBeenCalledWith('tab-first', expect.objectContaining({ workspaceId: 'ws-r', agentSessionId: 'sess-123' }));
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});
