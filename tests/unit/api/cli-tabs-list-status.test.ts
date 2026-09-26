import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const statuses = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('@/lib/layout-store', () => ({
  addTabToPane: vi.fn(),
  getLayout: vi.fn(async () => ({ root: {} })),
  isAgentPanelType: (panelType?: string) => panelType === 'claude-code',
}));
vi.mock('@/lib/layout-tree', () => ({
  collectPanes: vi.fn(() => [{
    tabs: [
      { id: 'tab-busy', name: 'worker', sessionName: 'pt-ws-a-p-tab-busy', panelType: 'claude-code', cliState: 'idle' },
      { id: 'tab-new', name: 'fresh', sessionName: 'pt-ws-a-p-tab-new', panelType: 'claude-code', cliState: 'busy' },
      { id: 'tab-sh', name: 'shell', sessionName: 'pt-ws-a-p-tab-sh', panelType: 'terminal' },
    ],
  }]),
}));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: vi.fn(async (id: string) => ({ id, directories: ['/repo'] })),
  getWorkspaces: vi.fn(async () => ({ workspaces: [{ id: 'ws-a' }] })),
}));
vi.mock('@/lib/cli-utils', () => ({
  authorizeWorkspace: vi.fn(async () => ({ type: 'admin' })),
  canAccessWorkspace: vi.fn(async () => true),
  resolveFirstPaneId: vi.fn(),
}));
vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: vi.fn(() => ({ type: 'admin' })) }));
vi.mock('@/lib/providers', () => ({ getProviderByPanelType: vi.fn(() => null) }));
vi.mock('@/lib/agent-availability', () => ({ checkAgentAvailabilityForPanelType: vi.fn(), toAgentAvailabilityError: vi.fn() }));
vi.mock('@/lib/agent-effort', () => ({ isValidReasoningForPanelType: vi.fn(), reasoningErrorForPanelType: vi.fn() }));
vi.mock('@/lib/claude-command', () => ({ buildClaudeFlags: vi.fn(), isValidModelName: vi.fn() }));
vi.mock('@/lib/providers/grok', () => ({ grokProvider: { buildLaunchCommand: vi.fn() } }));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ getAllForClient: () => statuses.value }),
}));
vi.mock('@/lib/agent-dispatch-policy', () => ({ checkAgentDispatchPolicy: vi.fn() }));
vi.mock('@/lib/providers/codex/managed-launch', () => ({
  prepareCodexManagedLaunch: vi.fn(),
  submitCodexManagedLaunch: vi.fn(),
  waitForCodexManagedLaunch: vi.fn(),
}));

const listTabs = async () => {
  const { default: handler } = await import('@/pages/api/cli/tabs');
  const state: { statusCode: number; body: { tabs: Array<Record<string, unknown>> } } = {
    statusCode: 0,
    body: { tabs: [] },
  };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: typeof state.body) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({ method: 'GET', headers: {}, query: {} } as unknown as NextApiRequest, res);
  return state;
};

describe('GET /api/cli/tabs status fields', () => {
  beforeEach(() => {
    statuses.value = {
      'tab-busy': { cliState: 'busy', lastEvent: { name: 'stop', at: 5, seq: 9 }, busySince: 3 },
    };
  });

  it('adds the live cliState, lastEvent and busySince of each tab', async () => {
    const { statusCode, body } = await listTabs();
    expect(statusCode).toBe(200);
    expect(body.tabs[0]).toMatchObject({
      tabId: 'tab-busy',
      cliState: 'busy',
      lastEvent: { name: 'stop', at: 5, seq: 9 },
      busySince: 3,
    });
  });

  it('falls back to the persisted cliState when the tab has no live status entry', async () => {
    const { body } = await listTabs();
    expect(body.tabs[1]).toMatchObject({ tabId: 'tab-new', cliState: 'busy', lastEvent: null, busySince: null });
  });

  it('reports null for a tab that has neither a live nor a persisted state', async () => {
    const { body } = await listTabs();
    expect(body.tabs[2]).toMatchObject({ tabId: 'tab-sh', cliState: null, lastEvent: null, busySince: null });
  });
});
