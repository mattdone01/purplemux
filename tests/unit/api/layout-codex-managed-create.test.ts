import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const layout = vi.hoisted(() => ({
  addTabToPane: vi.fn(),
  updateTabAgentSessionId: vi.fn(),
}));
const managed = vi.hoisted(() => ({
  prepareCodexManagedLaunch: vi.fn(),
  submitCodexManagedLaunch: vi.fn(),
  waitForCodexManagedLaunch: vi.fn(),
}));
const manager = vi.hoisted(() => ({ registerTab: vi.fn(), markAgentLaunch: vi.fn() }));
const provider = vi.hoisted(() => ({
  id: 'codex',
  panelType: 'codex-cli',
  isValidSessionId: vi.fn(() => true),
  readSessionId: vi.fn(() => null),
  writeSessionId: vi.fn(),
}));

vi.mock('@/lib/layout-store', () => layout);
vi.mock('@/lib/providers/codex/managed-launch', () => managed);
vi.mock('@/lib/providers/codex', () => ({ CODEX_PROVIDER_ID: 'codex' }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => manager }));
vi.mock('@/lib/providers', () => ({ getProviderByPanelType: vi.fn(() => provider) }));
vi.mock('@/lib/agent-availability', () => ({
  checkAgentAvailabilityForPanelType: vi.fn(async () => ({ ok: true })),
  toAgentAvailabilityError: vi.fn(),
}));
vi.mock('@/lib/workspace-store', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-pins') }));

const response = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(body: unknown) { state.body = body; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

describe('layout Codex tab creation lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    layout.addTabToPane.mockResolvedValue({
      id: 'tab-new',
      sessionName: 'pt-ws-pins-pane-one-tab-new',
      name: 'Codex',
      order: 0,
      panelType: 'codex-cli',
    });
    managed.prepareCodexManagedLaunch.mockResolvedValue({
      ok: true,
      launch: { generation: 'codex-generation' },
    });
    managed.submitCodexManagedLaunch.mockResolvedValue({
      ok: true,
      generation: 'codex-generation',
      phase: 'submitted',
    });
    managed.waitForCodexManagedLaunch.mockResolvedValue({
      ok: true,
      generation: 'codex-generation',
      phase: 'active',
    });
  });

  it('allocates the tab before the server prepares and submits its managed command', async () => {
    const { default: handler } = await import('@/pages/api/layout/pane/[paneId]/tabs');
    const { state, res } = response();
    await handler({
      method: 'POST',
      query: { workspace: 'ws-pins', paneId: 'pane-one' },
      body: { panelType: 'codex-cli', command: 'legacy-builder-command' },
    } as unknown as NextApiRequest, res);
    expect(layout.addTabToPane).toHaveBeenCalledWith(
      'ws-pins', 'pane-one', undefined, undefined, 'codex-cli', undefined,
    );
    expect(managed.prepareCodexManagedLaunch).toHaveBeenCalledWith('ws-pins', 'tab-new', null);
    expect(managed.submitCodexManagedLaunch).toHaveBeenCalledWith(
      'ws-pins', 'tab-new', 'codex-generation',
    );
    expect(managed.waitForCodexManagedLaunch).toHaveBeenCalledWith(
      'ws-pins', 'tab-new', 'codex-generation',
    );
    expect(state.statusCode).toBe(200);
  });

  it('does not bind a requested resume session before launcher confirmation', async () => {
    const { default: handler } = await import('@/pages/api/layout/pane/[paneId]/tabs');
    const { res } = response();
    const resumeSessionId = '01a008c1-bb96-71d1-9769-b63ff478fd9f';
    await handler({
      method: 'POST',
      query: { workspace: 'ws-pins', paneId: 'pane-one' },
      body: { panelType: 'codex-cli', resumeSessionId },
    } as unknown as NextApiRequest, res);
    expect(managed.prepareCodexManagedLaunch).toHaveBeenCalledWith(
      'ws-pins', 'tab-new', resumeSessionId,
    );
    expect(layout.updateTabAgentSessionId).not.toHaveBeenCalled();
    expect(provider.writeSessionId).not.toHaveBeenCalled();
  });
});
