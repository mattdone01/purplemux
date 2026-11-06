import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signSessionToken } from '@/lib/auth';

// Story 57 (D35): who may run test-only (a scratch workspace only), what the owner's routes serve (never a test-only
// run unless the explicit ?includeTest=1 read, which the board and pulse refuse), and that no push leaves a scratch
// workspace.

const store = vi.hoisted(() => ({
  applyEvents: vi.fn(),
  unreplayedEventIds: vi.fn(),
  itemStates: vi.fn(() => new Map()),
  humanInboxPolicy: vi.fn(),
  eventsAfter: vi.fn(),
}));
const runtime = vi.hoisted(() => ({ getMissionSnapshot: vi.fn(), resolveMissionTargetIdentity: vi.fn() }));
const scope = vi.hoisted(() => ({ resolveCliScope: vi.fn(), isOwnWorkspace: vi.fn(), canAccessWorkspace: vi.fn() }));
const workspace = vi.hoisted(() => ({ getWorkspaceById: vi.fn(), getWorkspaces: vi.fn() }));
const alerts = vi.hoisted(() => ({ alertOpenedAttention: vi.fn() }));
const views = vi.hoisted(() => ({ readBoard: vi.fn(), readPulse: vi.fn() }));

vi.mock('@/lib/mission-control-store', () => ({ getMissionControlStore: () => store }));
vi.mock('@/lib/mission-control-runtime', () => runtime);
vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: scope.resolveCliScope }));
vi.mock('@/lib/cli-utils', () => ({
  isOwnWorkspace: scope.isOwnWorkspace, canDriveWorkspace: scope.isOwnWorkspace, canAccessWorkspace: scope.canAccessWorkspace,
}));
vi.mock('@/lib/workspace-store', () => workspace);
vi.mock('@/lib/attention-alerts', () => alerts);
vi.mock('@/lib/board', () => ({ readBoard: views.readBoard }));
vi.mock('@/lib/pulse-service', () => ({ readPulse: views.readPulse }));

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const call = async (route: string, request: Record<string, unknown>) => {
  const { default: handler } = await import(route) as { default: (req: NextApiRequest, res: NextApiResponse) => Promise<void> };
  const { state, res } = fakeResponse();
  await handler({ headers: {}, query: {}, ...request } as unknown as NextApiRequest, res);
  return state as { statusCode: number; body: { error?: string; code?: string } };
};

const question = { kind: 'question', title: 'Pick one', context: 'Fixture.', storyIds: [], options: [], recommendation: 'SM to rule', blockingScope: 'none', canContinue: true };
const start = (test?: boolean) => ({
  eventId: 'e-start', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 1, bindingGeneration: 0,
  type: 'run.started', payload: { objective: 'Fixture', tabId: 'tab-a', ...(test === undefined ? {} : { test }) },
});
const opened = (test?: boolean) => ({
  eventId: 'e-open', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
  type: 'attention.opened', payload: { itemId: 'item-a', ...question, ...(test === undefined ? {} : { test }) },
});
const post = (events: unknown[]) => call('@/pages/api/cli/mission-control/events', { method: 'POST', query: { workspaceId: 'ws-a' }, body: { events } });

let cookie = '';

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.NEXTAUTH_SECRET = 'mission-control-test-secret-at-least-32-bytes';
  cookie = `session-token=${await signSessionToken()}`;
  scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-a', tabVerified: true });
  scope.isOwnWorkspace.mockImplementation((s: { type: string; workspaceId?: string }, ws: string) => s.type === 'workspace' && s.workspaceId === ws);
  scope.canAccessWorkspace.mockResolvedValue(true);
  store.applyEvents.mockReturnValue({ events: [], cursor: 0, replayed: false });
  store.unreplayedEventIds.mockImplementation((events: Array<{ eventId: string }>) => new Set(events.map((e) => e.eventId)));
  store.humanInboxPolicy.mockReturnValue({ version: 1, legacyReviewPending: 0 });
  store.eventsAfter.mockReturnValue({ schemaVersion: 1, events: [], cursor: 0, hasMore: false });
  runtime.getMissionSnapshot.mockResolvedValue({ schemaVersion: 1, cursor: 0 });
  runtime.resolveMissionTargetIdentity.mockResolvedValue({ tabId: 'tab-a', providerId: 'claude', sessionId: 's', runtimeGeneration: 'g' });
  workspace.getWorkspaceById.mockResolvedValue({ id: 'ws-a', name: 'A', directories: [], orchestration: null });
  workspace.getWorkspaces.mockResolvedValue({ workspaces: [{ id: 'ws-a' }] });
  alerts.alertOpenedAttention.mockResolvedValue([]);
  views.readBoard.mockResolvedValue({ workspaceId: 'ws-a' });
  views.readPulse.mockResolvedValue({ workspaceId: 'ws-a' });
});

describe('who may run test-only (POST /api/cli/mission-control/events)', () => {
  it('refuses test: true from a workspace that is not scratch, before storage', async () => {
    for (const events of [[start(true)], [opened(true)]]) {
      const r = await post(events);
      expect(r.statusCode).toBe(403);
      expect(r.body.error).toMatch(/not a scratch workspace/);
    }
    expect(store.applyEvents).not.toHaveBeenCalled();
  });

  it('refuses test: false in a scratch workspace, which contradicts it', async () => {
    workspace.getWorkspaceById.mockResolvedValue({ id: 'ws-a', name: 'S', directories: [], orchestration: null, scratch: true });
    const r = await post([start(false)]);
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toMatch(/contradicts the workspace/);
    expect(store.applyEvents).not.toHaveBeenCalled();
  });

  it('applies a scratch workspace batch as test-only, flag or none, and pushes nothing', async () => {
    workspace.getWorkspaceById.mockResolvedValue({ id: 'ws-a', name: 'S', directories: [], orchestration: null, scratch: true });
    for (const events of [[start(true), opened(true)], [start()]]) {
      const r = await post(events);
      expect(r.statusCode).toBe(200);
      expect(store.applyEvents).toHaveBeenLastCalledWith(expect.any(Array), expect.any(Map), expect.objectContaining({ testWorkspace: true }));
    }
    expect(alerts.alertOpenedAttention).not.toHaveBeenCalled();
  });

  it('applies a live workspace batch as before, with its push', async () => {
    const r = await post([start()]);
    expect(r.statusCode).toBe(200);
    expect(store.applyEvents.mock.calls[0][2]).not.toHaveProperty('testWorkspace');
    expect(alerts.alertOpenedAttention).toHaveBeenCalledTimes(1);
  });

  it('treats a stored scratch value other than true as a live workspace', async () => {
    workspace.getWorkspaceById.mockResolvedValue({ id: 'ws-a', name: 'A', directories: [], orchestration: null, scratch: 'yes' });
    expect((await post([start(true)])).statusCode).toBe(403);
  });
});

describe("the owner's routes never serve a test-only run by default", () => {
  it('GET /api/mission-control hides test-only runs unless ?includeTest=1, and refuses any other value', async () => {
    expect((await call('@/pages/api/mission-control/index', { method: 'GET', headers: { cookie } })).statusCode).toBe(200);
    expect(runtime.getMissionSnapshot).toHaveBeenLastCalledWith(undefined, { includeTest: false });

    expect((await call('@/pages/api/mission-control/index', { method: 'GET', headers: { cookie }, query: { includeTest: '1' } })).statusCode).toBe(200);
    expect(runtime.getMissionSnapshot).toHaveBeenLastCalledWith(undefined, { includeTest: true });

    const typo = await call('@/pages/api/mission-control/index', { method: 'GET', headers: { cookie }, query: { includeTest: 'true' } });
    expect(typo.statusCode).toBe(400);
    expect(runtime.getMissionSnapshot).toHaveBeenCalledTimes(2);
  });

  it('GET /api/mission-control/events hides test-only runs unless ?includeTest=1', async () => {
    await call('@/pages/api/mission-control/events', { method: 'GET', headers: { cookie } });
    expect(store.eventsAfter).toHaveBeenLastCalledWith(0, 100, undefined, { hideTest: true });
    await call('@/pages/api/mission-control/events', { method: 'GET', headers: { cookie }, query: { includeTest: '1' } });
    expect(store.eventsAfter).toHaveBeenLastCalledWith(0, 100, undefined, { hideTest: false });
  });

  it.each([
    ['@/pages/api/mission-control/board', 'board', views.readBoard],
    ['@/pages/api/mission-control/pulse', 'pulse', views.readPulse],
  ])('%s refuses includeTest with 403 and serves the owner view without it', async (route, view, reader) => {
    const refused = await call(route, { method: 'GET', headers: { cookie }, query: { includeTest: '1' } });
    expect(refused.statusCode).toBe(403);
    expect(refused.body.error).toContain(`includeTest is refused on the ${view}`);
    expect(reader).not.toHaveBeenCalled();
    expect((await call(route, { method: 'GET', headers: { cookie }, query: { workspaceId: 'ws-a' } })).statusCode).toBe(200);
  });

  it('serves a workspace its own test-only runs on the CLI read, and hides them from a portfolio read', async () => {
    await call('@/pages/api/cli/mission-control/index', { method: 'GET', query: { workspaceId: 'ws-a' } });
    expect(runtime.getMissionSnapshot).toHaveBeenLastCalledWith('ws-a', { includeTest: true });
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-manager' });
    await call('@/pages/api/cli/mission-control/index', { method: 'GET', query: { workspaceId: 'ws-a' } });
    expect(runtime.getMissionSnapshot).toHaveBeenLastCalledWith('ws-a', { includeTest: false });
  });
});
