import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentProvider } from '@/lib/providers/types';

const tmux = vi.hoisted(() => ({
  createSession: vi.fn(async () => {}),
  getPaneCurrentCommand: vi.fn(async () => 'bash'),
  getSessionPanePid: vi.fn(),
  hasSession: vi.fn(async () => true),
  sendKeysSeparated: vi.fn(async () => {}),
}));
const markAgentLaunch = vi.hoisted(() => vi.fn());
const managed = vi.hoisted(() => ({
  prepareCodexManagedLaunch: vi.fn(),
  submitCodexManagedLaunch: vi.fn(),
  waitForCodexManagedLaunch: vi.fn(),
}));

vi.mock('@/lib/tmux', () => tmux);
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ markAgentLaunch }) }));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaces: vi.fn(async () => ({ workspaces: [] })) }));
vi.mock('@/lib/process-utils', () => ({ getChildPids: vi.fn(), getProcessArgs: vi.fn() }));
vi.mock('@/lib/providers/codex/managed-launch', () => managed);

describe('auto resume agent launch config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('forwards the persisted tab pins to the provider resume command', async () => {
    const buildResumeCommand = vi.fn(async () => 'resume-command');
    const provider = {
      id: 'codex',
      displayName: 'Codex',
      buildResumeCommand,
    } as unknown as IAgentProvider;
    const { executeAutoResume } = await import('@/lib/auto-resume');

    await executeAutoResume([{
      workspaceId: 'ws-pins',
      tabId: 'tab-pins',
      tmuxSession: 'pt-ws-pins-pane-one-tab-pins',
      sessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f',
      provider,
      agentLaunchConfig: { model: 'gpt-5.6-sol', effort: 'high' },
    }]);

    expect(managed.prepareCodexManagedLaunch).toHaveBeenCalledWith(
      'ws-pins', 'tab-pins', '01a008c1-bb96-71d1-9769-b63ff478fd9f',
    );
    expect(managed.submitCodexManagedLaunch).toHaveBeenCalledWith(
      'ws-pins', 'tab-pins', 'codex-generation',
    );
    expect(managed.waitForCodexManagedLaunch).toHaveBeenCalledWith(
      'ws-pins', 'tab-pins', 'codex-generation',
    );
    expect(buildResumeCommand).not.toHaveBeenCalled();
    expect(tmux.sendKeysSeparated).not.toHaveBeenCalled();
  });
});
