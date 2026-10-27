import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILayoutData } from '@/types/terminal';

// ADR-0028 §2: the restart takes the workspace mapping read guard once. The lease is not re-entrant and a
// queued writer blocks later readers, so any nested read — in the restart, the recreate or the REAL
// launcher — deadlocks behind a writer queued mid-restart. Only tmux, the process observation and the
// provider's command builder below the launcher are mocked.

const mockHome = vi.hoisted(() => ({ value: '' }));
const tmux = vi.hoisted(() => ({
  killSession: vi.fn(),
  hasSession: vi.fn(async (_name: string) => false),
  createSession: vi.fn(async () => {}),
  sendKeysSeparated: vi.fn(async () => {}),
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
  ...tmux,
  hasSessionOrUnreachable: vi.fn(async () => true),
  listSessions: vi.fn(async () => []),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sendKeys: vi.fn(async () => {}),
  observeTabSessionsStrict: vi.fn(async () => ({ state: 'absent' })),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/workspace-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-store')>()),
  getWorkspaceById: vi.fn(async (id: string) => (id === 'ws-g' ? { id, name: 'g', directories: ['/srv/g'] } : null)),
}));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ getTabAgentState: () => null, markAgentLaunch: vi.fn(), markCodexLaunchPending: vi.fn() }),
}));
vi.mock('@/lib/orchestration-runtime', () => ({ observeOrchestrationProcess: vi.fn(async () => ({ state: 'absent' })) }));
vi.mock('@/lib/claude-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/claude-command')>()),
  buildResumeCommand: vi.fn(async (sessionId: string) => `claude --resume ${sessionId}`),
}));

const WS = 'ws-g';
const SESSION = `pt-${WS}-pane-a-tab-t`;
const SESSION_ID = '0b5c3a3e-6a8e-4c39-9f1e-2a5f3c1d9e70';
const REAP = { reaper: 'linux', envMarker: 'present', killed: [], survivors: [] };

describe('tab restart under a queued mapping writer (ADR-0028 §2)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    for (const key of ['__ptTabLifecycle', '__ptTabTokens', '__ptTabTokenLock', '__ptLayoutContentCache', '__ptLayoutLock', '__ptOrchestrationMappingGates']) {
      delete (globalThis as Record<string, unknown>)[key];
    }
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-restart-guard-'));
    const store = await import('@/lib/layout-store');
    const layout: ILayoutData = {
      root: {
        type: 'pane', id: 'pane-a', activeTabId: 'tab-t',
        tabs: [{
          id: 'tab-t', sessionName: SESSION, name: 'worker', order: 0, cwd: '/srv/g', panelType: 'claude-code',
          agentState: { providerId: 'claude', sessionId: SESSION_ID, jsonlPath: null, summary: null },
        }],
      },
      activePaneId: 'pane-a',
      updatedAt: '2026-10-27T00:00:00.000Z',
    };
    await store.writeLayoutFile(layout, store.resolveLayoutFile(WS));
  });

  afterEach(async () => {
    await (globalThis as { __ptTabTokenLock?: Promise<void> }).__ptTabTokenLock;
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('a writer queued mid-restart and the restart both finish, through the real launcher', async () => {
    let releaseKill: () => void = () => {};
    tmux.killSession.mockImplementation(() => new Promise((resolve) => { releaseKill = () => resolve(REAP); }));
    const { restartTab } = await import('@/lib/tab-restart');
    const { withOrchestrationMappingWrite } = await import('@/lib/orchestration-mapping-lock');

    const restart = restartTab({ workspaceId: WS, tabId: 'tab-t', clear: false, interrupt: false, by: { kind: 'human', actor: 'owner' } });
    await vi.waitFor(() => expect(tmux.killSession).toHaveBeenCalled());
    const writer = withOrchestrationMappingWrite(WS, async () => 'written');
    releaseKill();

    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 2_000));
    const [restarted, written] = await Promise.race([Promise.all([restart, writer]), timeout]) as [{ status: number; body: unknown }, string];
    expect(restarted).toMatchObject({ status: 200, body: { resumed: true } });
    expect(written).toBe('written');
    // The real launcher typed the resume: the guard-free path ran end to end.
    expect(tmux.sendKeysSeparated).toHaveBeenCalledWith(SESSION, `claude --resume ${SESSION_ID}`);
  });
});
