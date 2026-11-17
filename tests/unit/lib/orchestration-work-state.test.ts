import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ layout: vi.fn(), leases: vi.fn(), standup: vi.fn(), jobs: vi.fn(), runtime: vi.fn(), process: vi.fn(), statuses: {} as Record<string, unknown> }));
vi.mock('@/lib/workspace-layout-read', () => ({ readWorkspaceLayout: fixture.layout }));
vi.mock('@/lib/layout-store', () => ({ collectAllTabs: (tabs: unknown) => tabs, isAgentPanelType: (type: string) => type === 'claude-code' }));
vi.mock('@/lib/lease-store', () => ({ readLeaseEvidence: fixture.leases }));
vi.mock('@/lib/standup-store', () => ({ readLatestStandupEvidence: fixture.standup }));
vi.mock('@/lib/liveness-store', () => ({ readLivenessEvidence: fixture.jobs }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ getAllForClient: () => fixture.statuses }) }));
vi.mock('@/lib/orchestration-runtime', () => ({ observeOrchestrationRuntime: fixture.runtime }));
vi.mock('@/lib/process-utils', () => ({ observeProcessExistence: fixture.process }));
import { readOrchestrationWorkState } from '@/lib/orchestration-work-state';
const workspace = { id: 'ws-a', name: 'A', directories: [], orchestration: { enabled: true, orchestratorTabId: 'root' } };
beforeEach(() => {
  vi.clearAllMocks(); fixture.layout.mockResolvedValue({ root: [{ id: 'root', name: 'root', panelType: 'claude-code' }] });
  fixture.leases.mockResolvedValue({ known: true, leases: [] }); fixture.standup.mockResolvedValue({ known: true, standup: { state: 'done' } });
  fixture.jobs.mockResolvedValue({ known: true, data: { jobs: [] } }); fixture.runtime.mockResolvedValue({ state: 'present', identity: 'live' });
  fixture.process.mockResolvedValue({ state: 'present', identity: 'job' }); fixture.statuses = { root: { workspaceId: 'ws-a', cliState: 'idle' } };
});
describe('fresh shared work-state classifier for clear/off', () => {
  it('allows explicit completion, then reads changed evidence again without dashboard cache', async () => {
    expect(await readOrchestrationWorkState(workspace)).toMatchObject({ state: 'complete', incomplete: false });
    fixture.standup.mockResolvedValue({ known: true, standup: { state: 'awaiting-human' } });
    expect(await readOrchestrationWorkState(workspace)).toMatchObject({ state: 'remaining' });
    expect(fixture.standup).toHaveBeenCalledTimes(2);
  });
  it.each(['lease', 'busy', 'job'])('retains ownership for %s despite a done standup', async (source) => {
    if (source === 'lease') fixture.leases.mockResolvedValue({ known: true, leases: [{ name: 'epic:work', holder: { workspaceId: 'ws-a' } }] });
    if (source === 'busy') fixture.statuses = { root: { workspaceId: 'ws-a', cliState: 'busy' } };
    if (source === 'job') fixture.jobs.mockResolvedValue({ known: true, data: { jobs: [{ tabId: 'closed-worker', pid: 7 }] } });
    expect(await readOrchestrationWorkState(workspace)).toMatchObject({ state: 'remaining' });
  });
  it.each(['layout', 'lease', 'standup', 'background', 'runtime', 'process'])('does not infer completion from unknown %s', async (source) => {
    if (source === 'layout') fixture.layout.mockRejectedValue(new Error('broken'));
    if (source === 'lease') fixture.leases.mockResolvedValue({ known: false });
    if (source === 'standup') fixture.standup.mockResolvedValue({ known: false });
    if (source === 'background') fixture.jobs.mockResolvedValue({ known: false });
    if (source === 'runtime') fixture.runtime.mockResolvedValue({ state: 'unknown' });
    if (source === 'process') { fixture.jobs.mockResolvedValue({ known: true, data: { jobs: [{ tabId: 'closed', pid: 7 }] } }); fixture.process.mockResolvedValue({ state: 'unknown' }); }
    expect(await readOrchestrationWorkState(workspace)).toMatchObject({ state: 'unknown', incomplete: true });
  });
  // 16 Nov: `orchestration off` refused with "active agent tab: <the caller itself>". The verified caller's own turn is the
  // call; it is not work that keeps a coordinator. Every other source still counts.
  it('does not count the verified caller tab as active work', async () => {
    fixture.statuses = { root: { workspaceId: 'ws-a', cliState: 'busy' } };
    expect(await readOrchestrationWorkState(workspace)).toMatchObject({ state: 'remaining', evidence: ['active agent tab: root'] });
    expect(await readOrchestrationWorkState(workspace, { callerTabId: 'root' })).toMatchObject({ state: 'complete', incomplete: false });
  });
  it('still counts the caller tab\'s registered job, another busy tab, and an unknown other tab', async () => {
    fixture.layout.mockResolvedValue({ root: [{ id: 'root', name: 'root', panelType: 'claude-code' }, { id: 'worker', name: 'worker', panelType: 'claude-code' }] });
    fixture.statuses = { root: { workspaceId: 'ws-a', cliState: 'busy' }, worker: { workspaceId: 'ws-a', cliState: 'busy' } };
    expect(await readOrchestrationWorkState(workspace, { callerTabId: 'root' })).toMatchObject({ state: 'remaining', evidence: ['active agent tab: worker'] });
    fixture.statuses = { root: { workspaceId: 'ws-a', cliState: 'busy' }, worker: { workspaceId: 'ws-a', cliState: 'idle' } };
    fixture.jobs.mockResolvedValue({ known: true, data: { jobs: [{ tabId: 'root', pid: 7 }] } });
    expect(await readOrchestrationWorkState(workspace, { callerTabId: 'root' })).toMatchObject({ state: 'remaining', evidence: ['live registered background work: root'] });
    fixture.jobs.mockResolvedValue({ known: true, data: { jobs: [] } });
    fixture.runtime.mockImplementation(async (tab: { id: string }) => tab.id === 'worker' ? { state: 'unknown' } : { state: 'present', identity: 'live' });
    expect(await readOrchestrationWorkState(workspace, { callerTabId: 'root' })).toMatchObject({ state: 'unknown', incomplete: true });
  });
  it('a caller tab id that names no tab of the workspace changes nothing', async () => {
    fixture.statuses = { root: { workspaceId: 'ws-a', cliState: 'busy' } };
    expect(await readOrchestrationWorkState(workspace, { callerTabId: 'tab-elsewhere' })).toMatchObject({ state: 'remaining' });
  });
});
