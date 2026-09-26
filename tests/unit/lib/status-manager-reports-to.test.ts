import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { TLivenessEvent } from '@/types/liveness';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

const workspaceStore = vi.hoisted(() => ({
  getWorkspaceByIdCached: vi.fn(),
  getWorkspacesCached: vi.fn(),
}));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn(), removeTab: vi.fn() }));
const layout = vi.hoisted(() => ({ clearReportsTo: vi.fn(async () => [] as string[]) }));

vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: workspaceStore.getWorkspaceByIdCached,
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: workspaceStore.getWorkspacesCached,
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => liveness }));
vi.mock('@/lib/layout-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/layout-store')>()),
  clearReportsTo: layout.clearReportsTo,
}));

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

const entry = (id: string, extra: Partial<ITabStatusEntry> = {}): ITabStatusEntry => ({
  cliState: 'idle',
  workspaceId: 'ws-1',
  tabName: id,
  tmuxSession: `tmux-${id}`,
  panelType: 'claude-code',
  ...extra,
});

const setup = async (orchestration: { enabled: boolean; orchestratorTabId: string | null }) => {
  const ws = { id: 'ws-1', name: 'ws', directories: ['/tmp'], orchestration };
  workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
  workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}));
  const internals = manager as unknown as {
    nudgeOrchestrator: (tabId: string, e: ITabStatusEntry, kind: 'stuck', detail?: string) => Promise<void>;
    handleLivenessEvent: (event: TLivenessEvent) => Promise<void>;
    lastNudgeByTab: Map<string, unknown>;
  };
  const targets = () => paste.mock.calls.map(([session]) => session.replace('tmux-', ''));
  return { manager, internals, paste, targets };
};

const bgCompleted = (notify?: 'self' | 'orchestrator'): TLivenessEvent => ({
  kind: 'bg-completed',
  job: { workspaceId: 'ws-1', tabId: 'w', pid: 42, label: 'gate', registeredAt: 0, ...(notify ? { notify } : {}) },
  exitCode: 0,
  stderrTail: null,
});

describe('nudge routing — reportsTo and notify self (ADR-0018)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });

  it('sends W\'s nudge to O2 only while O2 is live, then to O1 after O2 closes', async () => {
    const { manager, internals, targets } = await setup({ enabled: true, orchestratorTabId: 'o1' });
    manager.registerTab('o1', entry('o1'));
    manager.registerTab('o2', entry('o2'));
    const w = entry('w', { reportsTo: 'o2' });
    manager.registerTab('w', w);

    await internals.nudgeOrchestrator('w', w, 'stuck');
    expect(targets()).toEqual(['o2']);

    manager.removeTab('o2');
    manager.forgetReportsTo('ws-1', 'o2');
    expect(w.reportsTo).toBeNull();
    expect(layout.clearReportsTo).toHaveBeenCalledWith('ws-1', 'o2');
    internals.lastNudgeByTab.clear();

    await internals.nudgeOrchestrator('w', w, 'stuck');
    expect(targets()).toEqual(['o2', 'o1']);
  });

  it('falls back to the orchestrator when reportsTo names a tab that is not live', async () => {
    const { manager, internals, targets } = await setup({ enabled: true, orchestratorTabId: 'o1' });
    manager.registerTab('o1', entry('o1'));
    const w = entry('w', { reportsTo: 'gone' });
    manager.registerTab('w', w);

    await internals.nudgeOrchestrator('w', w, 'stuck');
    expect(targets()).toEqual(['o1']);
  });

  it('never routes across workspaces even when an entry names a tab of another one', async () => {
    const { manager, internals, targets } = await setup({ enabled: true, orchestratorTabId: 'o1' });
    manager.registerTab('o1', entry('o1'));
    manager.registerTab('x', entry('x', { workspaceId: 'ws-2' }));
    const w = entry('w', { reportsTo: 'x' });
    manager.registerTab('w', w);

    await internals.nudgeOrchestrator('w', w, 'stuck');
    expect(targets()).toEqual(['o1']);
  });

  it('delivers to a live reportsTo even when workspace orchestration is off', async () => {
    const { manager, internals, targets } = await setup({ enabled: false, orchestratorTabId: null });
    manager.registerTab('o2', entry('o2'));
    const w = entry('w', { reportsTo: 'o2' });
    manager.registerTab('w', w);

    await internals.nudgeOrchestrator('w', w, 'stuck');
    expect(targets()).toEqual(['o2']);
  });

  it('keeps today\'s silence with no reportsTo and orchestration off', async () => {
    const { manager, internals, paste } = await setup({ enabled: false, orchestratorTabId: null });
    const w = entry('w');
    manager.registerTab('w', w);

    await internals.nudgeOrchestrator('w', w, 'stuck');
    expect(paste).not.toHaveBeenCalled();
  });

  it('sends a --notify self COMPLETED nudge to the registering tab', async () => {
    const { manager, internals, paste, targets } = await setup({ enabled: true, orchestratorTabId: 'o1' });
    manager.registerTab('o1', entry('o1'));
    manager.registerTab('w', entry('w', { reportsTo: 'o1' }));

    await internals.handleLivenessEvent(bgCompleted('self'));
    expect(targets()).toEqual(['w']);
    expect(paste.mock.calls[0][1]).toContain('BACKGROUND JOB COMPLETED');
  });

  it('routes a default bg outcome to reportsTo, else the orchestrator (today\'s behaviour)', async () => {
    const { manager, internals, targets } = await setup({ enabled: true, orchestratorTabId: 'o1' });
    manager.registerTab('o1', entry('o1'));
    manager.registerTab('o2', entry('o2'));
    manager.registerTab('w', entry('w', { reportsTo: 'o2' }));

    await internals.handleLivenessEvent(bgCompleted());
    await internals.handleLivenessEvent(bgCompleted('orchestrator'));
    manager.removeTab('o2');
    await internals.handleLivenessEvent(bgCompleted());
    expect(targets()).toEqual(['o2', 'o2', 'o1']);
  });
});
