import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it, vi } from 'vitest';

const scope = vi.hoisted(() => ({ resolveCliScope: vi.fn() }));
vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: scope.resolveCliScope }));

const call = async () => {
  const { default: handler } = await import('@/pages/api/cli/api-guide');
  const state = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.status = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    send(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({ method: 'GET', headers: {} } as NextApiRequest, res);
  return state;
};

describe('GET /api/cli/api-guide', () => {
  it('serves any resolved caller, a tab token included', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-1', tabVerified: true });
    const state = await call();
    expect(state.status).toBe(200);
    expect(String(state.body)).toContain('## Caller identity');
  });

  it('documents the burndown publish contract', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-1', tabVerified: true });
    const guide = String((await call()).body);
    expect(guide).toContain('POST /api/cli/workspaces/<workspaceId>/burndown        (purplemux burndown publish -w WS --json @FILE)');
    expect(guide).toContain('GET /api/cli/workspaces/<workspaceId>/burndown');
  });

  it('documents the flow publish contract and its codes (ADR-0026)', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-1', tabVerified: true });
    const guide = String((await call()).body);
    expect(guide).toContain('## Flow (ADR-0026)');
    expect(guide).toContain('POST /api/cli/workspaces/<workspaceId>/flow            (purplemux flow publish -w WS --json @FILE)');
    expect(guide).toContain('purplemux flow publish -w "$PMUX_WORKSPACE_ID" --json @flow.json');
    expect(guide).toContain('GET /api/cli/workspaces/<workspaceId>/flow[?history=all|window|none]');
    for (const code of ['flow-invalid', 'flow-too-large', 'flow-unreadable', 'flow-not-found']) expect(guide).toContain(code);
    for (const key of ['flow.window-minutes', 'flow.lock-busy-percent', 'flow.queue-length', 'flow.oldest-minutes']) {
      expect(guide.slice(guide.indexOf('Keys in use:'), guide.indexOf('GET /api/cli/fleet-config'))).toContain(key);
    }
    for (const rule of ['stale', 'lock-busy', 'queue-long', 'queue-old', 'queue-full', 'meter-over']) expect(guide).toContain(`    ${rule} `);
    expect(guide).toContain('"derived"?:');
  });

  it('refuses a caller no token resolves', async () => {
    scope.resolveCliScope.mockReturnValue(null);
    expect((await call()).status).toBe(403);
  });
});
