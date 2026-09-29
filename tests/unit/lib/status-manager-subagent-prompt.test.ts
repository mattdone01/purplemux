import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// ppc-48 review r4: a Codex native subagent's permission prompt moves the tab to needs-input. Its
// other hooks never reach the tab, and its root may have stopped already (tab-QizeO4: root Stop
// 02:04:23Z, subagent ran until 02:09:40Z), so the ack must not force busy: no root hook would
// follow to leave it, and a busy tab refuses every send.

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: vi.fn(),
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: vi.fn(),
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => ({ statusForTab: vi.fn(), removeTab: vi.fn() }) }));
vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux')>()),
  getSessionPanePid: vi.fn(async () => null),
  getSessionCwd: vi.fn(async () => null),
  getAllPanesInfo: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));

const SESSION = 'pt-ws-1-pane-a-tab-codex';
const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: SESSION, panelType: 'codex-cli' });

const makeManager = async (cliState: ITabStatusEntry['cliState']) => {
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste: vi.fn(async () => {}),
  });
  await import('@/lib/providers');
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}));
  manager.registerTab('tab-codex', {
    cliState, workspaceId: 'ws-1', tabName: 'coordinator', tmuxSession: SESSION, panelType: 'codex-cli', agentProviderId: 'codex',
  });
  const state = () => (manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs.get('tab-codex')!;
  return { manager, state };
};

describe("a Codex subagent's permission prompt returns the tab to where it was", () => {
  beforeEach(async () => {
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-subagent-prompt-'));
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('root stopped → subagent prompt → ack → ready-for-review, not busy', async () => {
    const { manager, state } = await makeManager('ready-for-review');

    manager.raiseSubagentPermission(SESSION);
    expect(state().cliState).toBe('needs-input');

    manager.ackNotificationInput('tab-codex', state().lastEvent!.seq);
    expect(state().cliState).toBe('ready-for-review');
  });

  it("the subagent's next hook (answered in the pane) also returns it, and clears the approval request", async () => {
    const { manager, state } = await makeManager('ready-for-review');
    manager.raiseSubagentPermission(SESSION);
    state().permissionRequest = { type: 'ExecApprovalRequest', command: 'rm -rf build' } as ITabStatusEntry['permissionRequest'];

    manager.resolveSubagentPrompt(SESSION);

    expect(state().cliState).toBe('ready-for-review');
    expect(state().permissionRequest).toBeNull();
  });

  it('a root event in between supersedes the return state: the ack then behaves as before (busy)', async () => {
    const { manager, state } = await makeManager('ready-for-review');
    manager.raiseSubagentPermission(SESSION);

    manager.clearSubagentPrompt(SESSION);
    manager.ackNotificationInput('tab-codex', state().lastEvent!.seq);

    expect(state().cliState).toBe('busy');
  });

  it("a root's own permission prompt still acks to busy", async () => {
    const { manager, state } = await makeManager('busy');
    manager.handleProviderEvent('codex', SESSION, { kind: 'notification', notificationType: 'permission_prompt' });
    expect(state().cliState).toBe('needs-input');

    manager.ackNotificationInput('tab-codex', state().lastEvent!.seq);

    expect(state().cliState).toBe('busy');
  });
});
