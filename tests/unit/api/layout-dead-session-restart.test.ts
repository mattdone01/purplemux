import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILayoutData } from '@/types/terminal';

// ADR-0028 §12: the dead-session route (POST /api/layout/pane/{p}/tabs/{t}) takes the tab's target
// lock inside its read guard, as `tab restart` does, so it waits for a restart instead of recreating
// the session between the restart's reap and the reap's confirmation.

const mockHome = vi.hoisted(() => ({ value: '' }));
const tmux = vi.hoisted(() => ({
  alive: false,
  createSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/tmux', () => ({
  createSession: tmux.createSession,
  hasSession: vi.fn(async () => tmux.alive),
  hasSessionOrUnreachable: vi.fn(async () => tmux.alive),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sendKeys: vi.fn(async () => {}),
  listSessions: vi.fn(async () => []),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/human-mutation', () => ({ authorizeHumanMutation: vi.fn(async () => true) }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ removeTab: vi.fn() }) }));

const WS = 'ws-d';

const response = () => {
  const result = { code: 0, body: undefined as unknown };
  const res = {
    status(code: number) { result.code = code; return this; },
    json(body: unknown) { result.body = body; return this; },
    setHeader() { return this; },
    end() { return this; },
  } as unknown as NextApiResponse;
  return { result, res };
};

describe('dead-session recreate during a restart', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tmux.alive = false;
    for (const key of ['__ptLayoutContentCache', '__ptLayoutLock', '__ptOrchestrationMappingGates', '__ptTabLifecycle']) {
      delete (globalThis as Record<string, unknown>)[key];
    }
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-dead-session-'));
    const store = await import('@/lib/layout-store');
    const layout: ILayoutData = {
      root: { type: 'pane', id: 'pane-a', activeTabId: 'tab-t', tabs: [{ id: 'tab-t', sessionName: `pt-${WS}-pane-a-tab-t`, name: 't', order: 0, cwd: '/srv' }] },
      activePaneId: 'pane-a',
      updatedAt: '2026-10-27T00:00:00.000Z',
    };
    await store.writeLayoutFile(layout, store.resolveLayoutFile(WS));
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('waits for the restart\'s target lock and does not create the session the restart recreated', async () => {
    const { withCodexTargetLock } = await import('@/lib/providers/codex/launch-lifecycle');
    const { withOrchestrationMappingRead } = await import('@/lib/orchestration-mapping-lock');
    let finishRestart: () => void = () => {};
    // The restart's locked section, as withAgentDispatchLock takes it: read guard, then the target lock.
    const restart = withOrchestrationMappingRead(WS, () => withCodexTargetLock(WS, 'tab-t', () => new Promise<void>((resolve) => {
      finishRestart = () => { tmux.alive = true; resolve(); };
    })));
    await new Promise((r) => setTimeout(r, 0));

    const { default: handler } = await import('@/pages/api/layout/pane/[paneId]/tabs/[tabId]/index');
    const { result, res } = response();
    const post = handler({ method: 'POST', query: { workspace: WS, paneId: 'pane-a', tabId: 'tab-t' }, body: {}, headers: {} } as unknown as NextApiRequest, res);
    await new Promise((r) => setTimeout(r, 20));
    expect(result.code).toBe(0);
    expect(tmux.createSession).not.toHaveBeenCalled();

    finishRestart();
    await Promise.all([restart, post]);
    expect(result).toEqual({ code: 200, body: { ok: true } });
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it('with no restart, it still recreates a dead session', async () => {
    const { default: handler } = await import('@/pages/api/layout/pane/[paneId]/tabs/[tabId]/index');
    const { result, res } = response();
    await handler({ method: 'POST', query: { workspace: WS, paneId: 'pane-a', tabId: 'tab-t' }, body: {}, headers: {} } as unknown as NextApiRequest, res);
    expect(result).toEqual({ code: 200, body: { ok: true } });
    expect(tmux.createSession).toHaveBeenCalledWith(`pt-${WS}-pane-a-tab-t`, 80, 24, '/srv', { workspaceId: WS, tabId: 'tab-t' });
  });
});
