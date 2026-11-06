import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Story 57: only the human create route makes a scratch workspace, from a boolean `scratch` in the body.

const created = vi.hoisted(() => ({ createWorkspace: vi.fn() }));
vi.mock('@/lib/human-mutation', () => ({ authorizeHumanMutation: vi.fn(async () => true) }));
vi.mock('@/lib/workspace-store', () => ({ createWorkspace: created.createWorkspace, getWorkspaces: vi.fn() }));
vi.mock('@/lib/workspace-default-tab', () => ({ readDefaultTab: vi.fn(async () => null), registerDefaultTab: vi.fn() }));
vi.mock('@/lib/layout-store', () => ({ updateTabAgentSessionId: vi.fn() }));
vi.mock('@/lib/providers', () => ({ getProviderByPanelType: vi.fn(() => null) }));
vi.mock('@/lib/agent-availability', () => ({ checkAgentAvailabilityForPanelType: vi.fn(), toAgentAvailabilityError: vi.fn() }));
vi.mock('@/lib/tmux', () => ({ sendKeys: vi.fn() }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: vi.fn() }));
vi.mock('@/lib/orchestration-activity', () => ({ recordOrchestrationLaunch: vi.fn() }));

const DIRECTORY = '/home/someone/code/scratch';

const route = async (body: Record<string, unknown>) => {
  const { default: handler } = await import('@/pages/api/workspace/index');
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; }, json(b: unknown) { state.body = b; return this; }, setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({ method: 'POST', headers: {}, query: {}, body: { directory: DIRECTORY, ...body } } as unknown as NextApiRequest, res);
  return state;
};

beforeEach(() => {
  vi.clearAllMocks();
  created.createWorkspace.mockResolvedValue({ id: 'ws-new', name: 'n', directories: [DIRECTORY] });
});

describe('POST /api/workspace: scratch (story 57)', () => {
  it('passes scratch: true to the create, and nothing when the body leaves it out or says false', async () => {
    expect((await route({ scratch: true })).statusCode).toBe(200);
    expect(created.createWorkspace).toHaveBeenLastCalledWith(DIRECTORY, undefined, undefined, { mkdir: false, scratch: true });
    for (const body of [{}, { scratch: false }]) {
      expect((await route(body)).statusCode).toBe(200);
      expect(created.createWorkspace).toHaveBeenLastCalledWith(DIRECTORY, undefined, undefined, { mkdir: false });
    }
  });

  it('refuses a scratch value that is not a boolean', async () => {
    const refused = await route({ scratch: 'yes' });
    expect(refused.statusCode).toBe(400);
    expect(created.createWorkspace).not.toHaveBeenCalled();
  });
});
