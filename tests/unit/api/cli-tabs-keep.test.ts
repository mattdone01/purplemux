import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITab } from '@/types/terminal';

// ADR-0048: `tab keep` sets the mark the dormant sweep obeys; PATCH { keep } on its own, input-grade authorization.

const cli = vi.hoisted(() => ({
  authorizeWorkspace: vi.fn(),
  authorizeWorkspaceInput: vi.fn(),
  findTab: vi.fn(),
}));
const layout = vi.hoisted(() => ({
  closeTab: vi.fn(),
  updateTabAgentLaunchConfig: vi.fn(),
  setTabReportsTo: vi.fn(async () => true),
  setTabReportOn: vi.fn(async () => true),
  setTabKeep: vi.fn(async () => true),
}));

vi.mock('@/lib/cli-utils', () => cli);
vi.mock('@/lib/layout-store', () => layout);
vi.mock('@/lib/providers', () => ({ getProviderByPanelType: () => ({ id: 'claude', readSessionId: () => null }) }));

const NOW = Date.parse('2026-11-16T00:00:00Z');

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const tab = (extra: Partial<ITab> = {}): ITab => ({ id: 'tab-w', name: 'w', order: 0, sessionName: 's-w', panelType: 'claude-code', ...extra });

const call = async (method: string, body?: unknown) => {
  const { state, res } = fakeResponse();
  const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]');
  await handler({ method, query: { workspaceId: 'ws-1', tabId: 'tab-w' }, body } as unknown as NextApiRequest, res);
  return state;
};

describe('PATCH { keep } on the tab route (ADR-0048)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    cli.authorizeWorkspaceInput.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-1' });
    cli.authorizeWorkspace.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-1' });
    cli.findTab.mockResolvedValue({ workspaceId: 'ws-1', paneId: 'pane-a', tab: tab() });
  });

  it('sets a keep with a duration and answers the stored mark', async () => {
    const keep = { until: NOW + 12 * 3_600_000, reason: 'owner review', at: NOW };
    expect(await call('PATCH', { keep: { reason: 'owner review', until: '12h' } })).toEqual({ statusCode: 200, body: { tabId: 'tab-w', workspaceId: 'ws-1', keep } });
    expect(layout.setTabKeep).toHaveBeenCalledWith('ws-1', 'tab-w', keep);
    expect(cli.authorizeWorkspaceInput).toHaveBeenCalled();
  });

  it('sets a keep with no expiry, and clears it with null', async () => {
    expect((await call('PATCH', { keep: { reason: 'lead seat' } })).body).toEqual({ tabId: 'tab-w', workspaceId: 'ws-1', keep: { until: null, reason: 'lead seat', at: NOW } });
    expect((await call('PATCH', { keep: null })).body).toEqual({ tabId: 'tab-w', workspaceId: 'ws-1', keep: null });
    expect(layout.setTabKeep).toHaveBeenLastCalledWith('ws-1', 'tab-w', null);
  });

  it.each([
    [{ keep: { until: '2h' } }, 'keep needs a reason (1-200 characters)'],
    [{ keep: { reason: 'x', until: '60d' } }, 'until is more than 30 days ahead; omit it for a keep with no expiry'],
    [{ keep: { reason: 'x' }, agentLaunchConfig: null }, 'keep is patched on its own'],
    [{ keep: 'forever' }, 'keep must be an object { reason, until? } or null'],
  ])('refuses %j with 400', async (body, error) => {
    expect(await call('PATCH', body)).toEqual({ statusCode: 400, body: { error } });
    expect(layout.setTabKeep).not.toHaveBeenCalled();
  });

  it('answers 404 for a tab the workspace does not hold', async () => {
    cli.findTab.mockResolvedValue(null);
    expect((await call('PATCH', { keep: { reason: 'x' } })).statusCode).toBe(404);
  });

  it('shows the mark on GET', async () => {
    cli.findTab.mockResolvedValue({ workspaceId: 'ws-1', paneId: 'pane-a', tab: tab({ keep: { until: null, reason: 'lead seat', at: 1 } }) });
    expect((await call('GET')).body).toMatchObject({ tabId: 'tab-w', keep: { until: null, reason: 'lead seat', at: 1 } });
  });
});
