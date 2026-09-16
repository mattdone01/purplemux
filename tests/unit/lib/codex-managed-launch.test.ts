import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({
  beginCodexLaunch: vi.fn(),
  holdCodexLaunch: vi.fn(),
  holdCodexLaunchLocked: vi.fn(),
  markCodexLaunchSubmittedLocked: vi.fn(),
  resolvePreparedCodexLaunchIntent: vi.fn(),
  withCodexTargetLock: vi.fn(async (_wsId: string, _tabId: string, work: () => Promise<unknown>) => work()),
}));
const tmux = vi.hoisted(() => ({
  checkTerminalProcess: vi.fn(),
  sendKeys: vi.fn(),
}));
const provider = vi.hoisted(() => ({ buildManagedCodexLaunchCommand: vi.fn() }));
const cli = vi.hoisted(() => ({ findTab: vi.fn() }));
const status = vi.hoisted(() => ({ markCodexLaunchPending: vi.fn() }));

vi.mock('@/lib/providers/codex/launch-lifecycle', () => lifecycle);
vi.mock('@/lib/tmux', () => tmux);
vi.mock('@/lib/providers/codex', () => provider);
vi.mock('@/lib/cli-utils', () => cli);
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => status }));

const intent = {
  generation: 'codex-generation',
  workspaceId: 'ws-pins',
  tabId: 'tab-pins',
  sessionName: 'pt-ws-pins-pane-one-tab-pins',
  resumeSessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f',
  launchedConfig: { model: 'gpt-5.6-sol', effort: 'high' },
};

describe('managed Codex launch callers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.beginCodexLaunch.mockResolvedValue({ ok: true, state: 'prepared', intent });
    lifecycle.resolvePreparedCodexLaunchIntent.mockResolvedValue(intent);
    lifecycle.markCodexLaunchSubmittedLocked.mockResolvedValue({ ok: true, state: 'submitted', intent });
    provider.buildManagedCodexLaunchCommand.mockResolvedValue('managed-command');
    cli.findTab.mockResolvedValue({ tab: { sessionName: intent.sessionName } });
    tmux.checkTerminalProcess.mockResolvedValue({ isSafe: true, processName: 'bash' });
    tmux.sendKeys.mockResolvedValue(undefined);
  });

  it('prepares an immutable generation before returning its command', async () => {
    const { prepareCodexManagedLaunch } = await import('@/lib/providers/codex/managed-launch');
    const result = await prepareCodexManagedLaunch('ws-pins', 'tab-pins', intent.resumeSessionId);
    expect(lifecycle.beginCodexLaunch).toHaveBeenCalledWith('ws-pins', 'tab-pins', {
      resumeSessionId: intent.resumeSessionId,
      transitionToCodexPanel: true,
    });
    expect(provider.buildManagedCodexLaunchCommand).toHaveBeenCalledWith(intent);
    expect(status.markCodexLaunchPending).toHaveBeenCalledWith('tab-pins', 'codex-generation');
    expect(result).toEqual({ ok: true, launch: { ...intent, command: 'managed-command' } });
  });

  it('holds an unsafe replacement without sending or binding the new session', async () => {
    tmux.checkTerminalProcess.mockResolvedValue({ isSafe: false, processName: 'codex' });
    const { submitCodexManagedLaunch } = await import('@/lib/providers/codex/managed-launch');
    const result = await submitCodexManagedLaunch('ws-pins', 'tab-pins', intent.generation);
    expect(lifecycle.holdCodexLaunchLocked).toHaveBeenCalledWith(
      'ws-pins', 'tab-pins', intent.generation, 'terminal-not-ready:codex',
    );
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(lifecycle.markCodexLaunchSubmittedLocked).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, phase: 'held' });
  });

  it('marks submitted only after terminal submission succeeds', async () => {
    const { submitCodexManagedLaunch } = await import('@/lib/providers/codex/managed-launch');
    const result = await submitCodexManagedLaunch('ws-pins', 'tab-pins', intent.generation);
    expect(tmux.sendKeys).toHaveBeenCalledWith(intent.sessionName, 'managed-command');
    expect(tmux.sendKeys.mock.invocationCallOrder[0])
      .toBeLessThan(lifecycle.markCodexLaunchSubmittedLocked.mock.invocationCallOrder[0]);
    expect(result).toEqual({ ok: true, generation: intent.generation, phase: 'submitted' });
  });

  it('holds a failed terminal submission and never marks it submitted', async () => {
    tmux.sendKeys.mockRejectedValue(new Error('tmux unavailable'));
    const { submitCodexManagedLaunch } = await import('@/lib/providers/codex/managed-launch');
    const result = await submitCodexManagedLaunch('ws-pins', 'tab-pins', intent.generation);
    expect(lifecycle.holdCodexLaunchLocked).toHaveBeenCalledWith(
      'ws-pins', 'tab-pins', intent.generation, 'terminal-submit-failed:tmux unavailable',
    );
    expect(lifecycle.markCodexLaunchSubmittedLocked).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, phase: 'held' });
  });

  it('does not resend an already-submitted or stale generation', async () => {
    lifecycle.resolvePreparedCodexLaunchIntent.mockResolvedValue(null);
    const { submitCodexManagedLaunch } = await import('@/lib/providers/codex/managed-launch');
    await submitCodexManagedLaunch('ws-pins', 'tab-pins', intent.generation);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it('reports activation only for the exact confirmed generation', async () => {
    cli.findTab.mockResolvedValue({
      tab: {
        codexLaunchRuntime: {
          active: { generation: intent.generation, phase: 'active' },
        },
      },
    });
    const { waitForCodexManagedLaunch } = await import('@/lib/providers/codex/managed-launch');
    await expect(waitForCodexManagedLaunch('ws-pins', 'tab-pins', intent.generation)).resolves.toEqual({
      ok: true,
      generation: intent.generation,
      phase: 'active',
    });
  });
});
