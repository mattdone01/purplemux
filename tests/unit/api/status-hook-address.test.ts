import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ADR-0050 (S1, A1-A2): the hook route stores a Claude tab's messaging address after the grammar check, and only for
// the generic events that carry it.

const statusManager = vi.hoisted(() => ({
  applyAgentHookMeta: vi.fn(),
  handleToolActivity: vi.fn(),
  handleProviderEvent: vi.fn(),
  poll: vi.fn(async () => {}),
  tabForTmuxSession: vi.fn((session: string) => (session === 'pt-ws-A-pane-a-tab-1'
    ? { tabId: 'tab-1', workspaceId: 'ws-A', panelType: 'claude-code', host: null, agentSessionId: 'sess-1' }
    : session === 'pt-ws-A-pane-a-tab-c'
      ? { tabId: 'tab-c', workspaceId: 'ws-A', panelType: 'codex-cli', host: null, agentSessionId: null }
      : null)),
}));

vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => statusManager }));
vi.mock('@/lib/cli-token', () => ({ verifyCliToken: () => true }));
vi.mock('@/lib/access-filter', () => ({ isRequestAllowed: () => true }));

const SOCKET = '/run/user/1000/cc-socks/4242.sock';

const post = async (body: unknown) => {
  const { default: handler } = await import('@/pages/api/status/hook');
  const res = { status() { return this; }, json() { return this; }, setHeader() { return this; }, end() { return this; } } as unknown as NextApiResponse;
  await handler({ method: 'POST', query: {}, body, socket: { remoteAddress: '127.0.0.1' }, headers: {} } as unknown as NextApiRequest, res);
};

describe('POST /api/status/hook (Claude): the messaging address (ADR-0050)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    (await import('@/lib/messaging-directory')).resetMessagingDirectory();
  });

  it.each(['session-start', 'prompt-submit', 'notification'])('stores the address and the permission mode of %s', async (event) => {
    await post({ event, session: 'pt-ws-A-pane-a-tab-1', socket: SOCKET, permissionMode: 'bypassPermissions' });
    const { addressOf } = await import('@/lib/messaging-directory');
    expect(addressOf('ws-A', 'tab-1')).toMatchObject({ workspaceId: 'ws-A', address: `uds:${SOCKET}`, agentSessionId: 'sess-1', permissionMode: 'bypassPermissions', host: null });
    expect(statusManager.handleProviderEvent).toHaveBeenCalled();
  });

  it.each([
    ['a bad path', { socket: '/a b.sock' }],
    ['a path that is not text', { socket: 42 }],
    ['an event that carries no address', { event: 'pre-compact', socket: SOCKET }],
    ['a session no tab owns', { session: 'pt-unknown', socket: SOCKET }],
    ['a tab that is not Claude', { session: 'pt-ws-A-pane-a-tab-c', socket: SOCKET }],
  ])('hook-route-socket-grammar: stores nothing for %s, and still applies the event', async (_label, extra) => {
    await post({ event: 'prompt-submit', session: 'pt-ws-A-pane-a-tab-1', ...extra });
    const { addressOf } = await import('@/lib/messaging-directory');
    expect(addressOf('ws-A', 'tab-1')).toBeNull();
    expect(addressOf('ws-A', 'tab-c')).toBeNull();
  });

  it('D8: a prompt-submit marked crossSession applies as a turn that no send started (fromTool), and a plain one as before', async () => {
    await post({ event: 'prompt-submit', session: 'pt-ws-A-pane-a-tab-1', crossSession: true });
    expect(statusManager.handleProviderEvent).toHaveBeenLastCalledWith('claude', 'pt-ws-A-pane-a-tab-1', { kind: 'prompt-submit', fromTool: true }, undefined, { replayed: false });
    await post({ event: 'prompt-submit', session: 'pt-ws-A-pane-a-tab-1' });
    expect(statusManager.handleProviderEvent).toHaveBeenLastCalledWith('claude', 'pt-ws-A-pane-a-tab-1', { kind: 'prompt-submit' }, undefined, { replayed: false });
    await post({ event: 'stop', session: 'pt-ws-A-pane-a-tab-1', crossSession: true });
    expect(statusManager.handleProviderEvent).toHaveBeenLastCalledWith('claude', 'pt-ws-A-pane-a-tab-1', { kind: 'stop' }, undefined, { replayed: false });
  });
});
