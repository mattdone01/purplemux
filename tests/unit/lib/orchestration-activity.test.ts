import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ITab } from '@/types/terminal';

const fixture = vi.hoisted(() => ({ home: '', now: 1000, send: vi.fn(), type: vi.fn(), submit: vi.fn(), reap: vi.fn(), session: vi.fn(), process: vi.fn() }));
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fixture.home }, homedir: () => fixture.home };
});
vi.mock('@/lib/tmux', async (original) => ({
  ...await original<typeof import('@/lib/tmux')>(),
  hasSession: vi.fn(async () => true), isContentPendingInComposer: vi.fn(async () => false), createSession: vi.fn(async () => undefined), resolveExistingDir: vi.fn(async () => '/tmp'),
  sendKeys: fixture.send, sendTypedText: fixture.type, sendBracketedPasteText: fixture.type, submitComposer: fixture.submit,
  killSession: fixture.reap, observeSessionStrict: fixture.session,
}));
vi.mock('@/lib/process-utils', async (original) => ({ ...await original<typeof import('@/lib/process-utils')>(), observeProviderProcess: fixture.process }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ isOrchestrationLaunchPending: () => false, isWaitingAtPrompt: () => true, getAllForClient: () => ({ 'tab-old': { workspaceId: 'ws-a', cliState: 'idle' } }) }) }));
vi.mock('@/lib/lease-store', () => ({ readLeaseEvidence: vi.fn(async () => ({ known: true, leases: [] })) }));
vi.mock('@/lib/standup-store', () => ({ readLatestStandupEvidence: vi.fn(async () => ({ known: true, standup: { state: 'done' } })) }));
vi.mock('@/lib/liveness-store', () => ({ readLivenessEvidence: vi.fn(async () => ({ known: true, data: { jobs: [] } })) }));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
const SESSION = 'pt-ws-a-pane-a-tab-old';
const file = () => path.join(fixture.home, '.purplemux/workspaces/ws-a/layout.json');
const readTab = async (): Promise<ITab> => JSON.parse(await fs.readFile(file(), 'utf8')).root.tabs[0];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const options = { expectedRevision: 0, mode: 'recover' as const, actor: { kind: 'workspace' as const, workspaceId: 'ws-a', tabId: 'tab-next', verified: false } };
let layout: typeof import('@/lib/layout-store');
let activity: typeof import('@/lib/orchestration-activity');
let recovery: typeof import('@/lib/orchestration-recovery');
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-activity-'));
  fixture.now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => fixture.now);
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await fs.writeFile(file(), JSON.stringify({ root: { type: 'pane', id: 'pane-a', activeTabId: 'tab-old', tabs: [
    { id: 'tab-old', name: 'Old', order: 0, panelType: 'claude-code', sessionName: SESSION },
    { id: 'tab-next', name: 'Next', order: 1, panelType: 'claude-code', sessionName: 'pt-ws-a-pane-a-tab-next' },
  ] }, activePaneId: 'pane-a' }));
  await fs.writeFile(path.join(fixture.home, '.purplemux/workspaces.json'), JSON.stringify({ workspaces: [{ id: 'ws-a', name: 'A', directories: [], orchestration: { enabled: true, orchestratorTabId: 'tab-old', revision: 0 } }], groups: [] }));
  for (const key of ['__purplemuxWorkspacesContentCache', '__ptWorkspacesMemo']) delete (globalThis as Record<string, unknown>)[key];
  fixture.send.mockResolvedValue(undefined); fixture.type.mockResolvedValue(undefined); fixture.submit.mockResolvedValue(undefined);
  fixture.reap.mockResolvedValue({ reaper: 'linux', envMarker: 'present', killed: [], survivors: [] });
  fixture.session.mockResolvedValue({ state: 'absent', reason: 'exact session absent' });
  fixture.process.mockResolvedValue({ state: 'present', identity: 'provider:123:456' });
  layout = await import('@/lib/layout-store'); activity = await import('@/lib/orchestration-activity');
  recovery = await import('@/lib/orchestration-recovery');
  vi.spyOn(await import('@/lib/cli-utils'), 'authorizeWorkspaceInput').mockResolvedValue({ type: 'workspace', workspaceId: 'ws-a' });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.home, { recursive: true, force: true }); });

describe('persisted pending lifecycle evidence through real layout and recovery services', () => {
  it('queues restart only after durable launch intent; shell absence cannot permit recovery after module reload', async () => {
    fixture.send.mockImplementation(async () => { expect((await readTab()).orchestrationActivity?.launch).toEqual({ at: 1000 }); });
    vi.mocked((await import('@/lib/tmux')).hasSession).mockResolvedValueOnce(false);
    await layout.restartTabSession('ws-a', 'pane-a', 'tab-old', 'sleep 1; claude');
    vi.resetModules();
    const { observeOrchestrationRuntime } = await import('@/lib/orchestration-runtime');
    expect(await observeOrchestrationRuntime(await readTab())).toMatchObject({ state: 'unknown' });
    await expect(recovery.changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options)).rejects.toMatchObject({ code: 'orchestrator-state-unknown' });
    expect(fixture.send).toHaveBeenCalledOnce();
  });
  it('does not queue restart when durable marker persistence fails', async () => {
    vi.mocked((await import('@/lib/tmux')).hasSession).mockResolvedValueOnce(false);
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(layout.restartTabSession('ws-a', 'pane-a', 'tab-old', 'claude')).rejects.toThrow('disk unavailable');
    expect(fixture.send).not.toHaveBeenCalled();
  });
  it('pending submitted turn blocks an already queued off writer before any busy hook arrives', async () => {
    const entered = deferred(); const release = deferred();
    fixture.submit.mockImplementation(async () => { expect((await readTab()).orchestrationActivity?.turn).toBeDefined(); entered.resolve(); await release.promise; });
    const { default: send } = await import('@/pages/api/cli/tabs/[tabId]/send');
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const delivery = send({ method: 'POST', query: { workspaceId: 'ws-a', tabId: 'tab-old' }, body: { content: 'work', waitMs: 0 } } as unknown as NextApiRequest, response as unknown as NextApiResponse);
    await Promise.race([entered.promise, delivery.then(() => { throw new Error(`Send returned before submission: ${JSON.stringify(response.json.mock.calls)}`); })]);
    const off = recovery.changeOrchestration('ws-a', { enabled: false }, options);
    const denied = expect(off).rejects.toMatchObject({ code: 'orchestration-work-remains' });
    release.resolve(); await delivery; await denied;
    expect(response.status).toHaveBeenCalledWith(200);
  });
  it('distinguishes input never submitted from uncertain terminal submission', async () => {
    const { deliverPrompt } = await import('@/lib/agent-prompt-delivery');
    fixture.type.mockRejectedValueOnce(new Error('text failed'));
    await expect(deliverPrompt(SESSION, 'work')).rejects.toThrow('text failed');
    expect((await readTab()).orchestrationActivity).toBeUndefined(); expect(fixture.submit).not.toHaveBeenCalled();
    fixture.submit.mockRejectedValueOnce(new Error('transport failed after write'));
    await expect(deliverPrompt(SESSION, 'work')).rejects.toThrow('transport failed after write');
    expect((await readTab()).orchestrationActivity?.turn).toBeDefined();
    await expect(recovery.changeOrchestration('ws-a', { enabled: false }, options)).rejects.toMatchObject({ code: 'orchestration-work-remains' });
  });
  it('requires current prompt-submit then a later stop/interrupt; session-start and time do not complete work', async () => {
    fixture.session.mockResolvedValue({ state: 'present', panePid: 42, identity: 'session:42' });
    await activity.recordOrchestrationSubmission(SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 1001);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'session-start', 1002);
    fixture.now = 1_000_000;
    expect((await readTab()).orchestrationActivity?.turn?.runningAt).toBeUndefined();
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 1003);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 1002);
    expect((await readTab()).orchestrationActivity?.turn).toMatchObject({ runningAt: 1003 });
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'interrupt', 1004);
    expect((await readTab()).orchestrationActivity?.turn).toBeUndefined();
  });
  it('old stop/replay cannot erase a newer submission or cross a restart generation', async () => {
    fixture.session.mockResolvedValue({ state: 'present', panePid: 42, identity: 'session:42' });
    await activity.recordOrchestrationSubmission(SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 1001);
    const first = (await readTab()).orchestrationActivity!.turn!.generation;
    fixture.now = 2000; await activity.recordOrchestrationSubmission(SESSION);
    expect((await readTab()).orchestrationActivity!.turn!.generation).not.toBe(first);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 1500);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 2001);
    fixture.now = 3000; await activity.recordOrchestrationLaunch('ws-a', 'tab-old', SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 3002);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'session-start', 3003);
    expect((await readTab()).orchestrationActivity?.turn).toBeDefined();
    fixture.now = 4000; await activity.recordOrchestrationSubmission(SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 3002);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 4001);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 4002);
    expect((await readTab()).orchestrationActivity?.turn).toBeUndefined();
  });
  it('an acknowledgment whose process probe finishes after a newer submission cannot clear it', async () => {
    fixture.session.mockResolvedValue({ state: 'present', panePid: 42, identity: 'session:42' });
    await activity.recordOrchestrationSubmission(SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 1001);
    const entered = deferred(); const release = deferred();
    fixture.process.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { state: 'present', identity: 'provider:123:456' }; });
    const stopped = activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 1002);
    await entered.promise;
    fixture.now = 2000; await activity.recordOrchestrationSubmission(SESSION);
    const newer = (await readTab()).orchestrationActivity!.turn!.generation;
    release.resolve(); await stopped;
    expect((await readTab()).orchestrationActivity?.turn?.generation).toBe(newer);
  });
  it('session-name reuse or changed provider process cannot acknowledge the previous running turn', async () => {
    fixture.session.mockResolvedValue({ state: 'present', panePid: 42, identity: 'session:42' });
    await activity.recordOrchestrationSubmission(SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'prompt-submit', 1001);
    fixture.process.mockResolvedValue({ state: 'present', identity: 'provider:123:999' });
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'stop', 1002);
    expect((await readTab()).orchestrationActivity?.turn).toBeDefined();
  });
  it('launch acknowledgment requires a new strict provider identity, and cannot turn an unknown prior identity into proof', async () => {
    fixture.session.mockResolvedValue({ state: 'present', panePid: 42, identity: 'session:42' });
    await activity.recordOrchestrationLaunch('ws-a', 'tab-old', SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'session-start', 1001);
    expect((await readTab()).orchestrationActivity?.launch).toBeDefined();
    fixture.process.mockResolvedValue({ state: 'present', identity: 'provider:123:999' });
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'session-start', 1002);
    expect((await readTab()).orchestrationActivity?.launch).toBeUndefined();
    fixture.process.mockResolvedValueOnce({ state: 'unknown', reason: 'unreadable process' });
    fixture.now = 2000; await activity.recordOrchestrationLaunch('ws-a', 'tab-old', SESSION);
    await activity.acknowledgeOrchestrationActivity('ws-a', 'tab-old', SESSION, 'session-start', 2001);
    expect((await readTab()).orchestrationActivity?.launch).toMatchObject({ priorUnknown: true });
  });
  it('client metadata cannot erase pending evidence or hide it by changing the panel type', async () => {
    await activity.recordOrchestrationSubmission(SESSION);
    await layout.patchTab('ws-a', 'pane-a', 'tab-old', { panelType: 'terminal', orchestrationActivity: undefined } as Parameters<typeof layout.patchTab>[3]);
    expect((await readTab()).orchestrationActivity?.turn).toBeDefined();
    await expect(recovery.changeOrchestration('ws-a', { enabled: false }, options)).rejects.toMatchObject({ code: 'orchestration-work-remains' });
  });
  it('only confirmed close/reap abandons uncertain work; newer restart waits behind the close', async () => {
    await activity.recordOrchestrationSubmission(SESSION);
    await expect(layout.closeTab('ws-a', 'pane-a', 'tab-old', { keepProcesses: true })).rejects.toThrow('confirmed process reap');
    fixture.session.mockResolvedValueOnce({ state: 'unknown', reason: 'tmux timeout' });
    await expect(layout.closeTab('ws-a', 'pane-a', 'tab-old')).rejects.toThrow('unconfirmed');
    expect((await readTab()).orchestrationActivity?.turn).toBeDefined();
    const entered = deferred(); const release = deferred();
    fixture.reap.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { reaper: 'linux', survivors: [], killed: [] }; });
    const closing = layout.closeTab('ws-a', 'pane-a', 'tab-old'); await entered.promise;
    const restart = layout.restartTabSession('ws-a', 'pane-a', 'tab-old', 'claude');
    release.resolve(); expect(await closing).toMatchObject({ ok: true }); expect(await restart).toBe(false);
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
