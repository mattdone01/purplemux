import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICodexModelStatus, TCodexModelStatusReason } from '@/lib/providers/codex/model-observation';
import type { ITab } from '@/types/terminal';

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  find: vi.fn(),
  model: vi.fn(),
  claim: vi.fn(),
  lock: vi.fn(async (_workspaceId: string, _tabId: string, work: () => Promise<unknown>) => work()),
}));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: mocks.workspace }));
vi.mock('@/lib/cli-utils', () => ({ findTab: mocks.find }));
vi.mock('@/lib/providers/codex/launch-lifecycle', () => ({
  claimCodexBootstrapLocked: mocks.claim,
  withCodexTargetLock: mocks.lock,
}));
vi.mock('@/lib/providers/codex/model-observation', () => ({ getCodexModelStatus: mocks.model }));
import {
  checkAgentDispatchPolicy,
  clearAgentDispatchPolicyState,
} from '@/lib/agent-dispatch-policy';

const tab = (id: string): ITab => ({
  id,
  name: id,
  order: 0,
  sessionName: id,
  panelType: 'codex-cli',
  agentLaunchConfig: { model: 'gpt-6-astra', effort: 'high' },
});

const modelStatus = (
  status: ICodexModelStatus['status'],
  reason: TCodexModelStatusReason = null,
): ICodexModelStatus => ({
  expected: { model: 'gpt-6-astra', effort: 'high' },
  observed: status === 'match' || status === 'mismatch'
    ? {
        model: status === 'match' ? 'gpt-6-astra' : 'gpt-5.6-luna',
        effort: 'high',
        source: 'turn_context',
        timestamp: '2026-09-10T10:00:00.000Z',
        sessionId: '11111111-1111-4111-8111-111111111111',
      }
    : null,
  latestTurn: null,
  latestSettings: null,
  scanState: status === 'unknown' && reason === 'scanning' ? 'scanning' : 'complete',
  hasActivity: false,
  status,
  reason,
});

describe('automated dispatch model guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAgentDispatchPolicyState();
    mocks.workspace.mockResolvedValue({ orchestration: { enabled: true, orchestratorTabId: 'root' } });
    mocks.find.mockImplementation(async (_workspaceId: string, id: string) => ({
      workspaceId: 'ws',
      paneId: 'pane-1',
      tab: tab(id),
    }));
    mocks.model.mockResolvedValue(modelStatus('match'));
    mocks.claim.mockResolvedValue({ ok: false, reason: 'not-pre-first-turn' });
  });

  it('holds new worker creation when the orchestrator model drifted', async () => {
    mocks.model.mockResolvedValue(modelStatus('mismatch'));

    expect(await checkAgentDispatchPolicy('ws')).toMatchObject({
      ok: false,
      error: 'agent-model-mismatch',
      tabId: 'root',
    });
  });

  it('holds a send to a mismatched worker even when the orchestrator matches', async () => {
    mocks.model.mockImplementation(async (value: ITab) =>
      modelStatus(value.id === 'worker' ? 'mismatch' : 'match'));

    expect(await checkAgentDispatchPolicy('ws', tab('worker'))).toMatchObject({
      ok: false,
      error: 'agent-model-mismatch',
      tabId: 'worker',
    });
  });

  it('allows a verified target and orchestrator', async () => {
    expect(await checkAgentDispatchPolicy('ws', tab('worker'))).toEqual({ ok: true });
    expect(mocks.model).toHaveBeenCalledTimes(2);
  });

  it.each<TCodexModelStatusReason>([
    'scanning',
    'session-unavailable',
    'session-identity-mismatch',
    'observation-unavailable',
    'runtime-unavailable',
  ])('holds established or unavailable unknown state: %s', async (reason) => {
    mocks.workspace.mockResolvedValue({ orchestration: { enabled: false } });
    mocks.model.mockResolvedValue(modelStatus('unknown', reason));

    expect(await checkAgentDispatchPolicy(
      'ws',
      tab('worker'),
      { consumeBootstrapForTarget: true },
    )).toMatchObject({ ok: false, error: 'agent-model-unverified', tabId: 'worker' });
  });

  it('requires an explicit delivery claim and permits awaiting-first-turn only once', async () => {
    mocks.workspace.mockResolvedValue({ orchestration: { enabled: false } });
    mocks.model.mockResolvedValue(modelStatus('unknown', 'awaiting-first-turn'));
    const worker = tab('worker');
    mocks.claim
      .mockResolvedValueOnce({ ok: true, generation: 'generation-1' })
      .mockResolvedValueOnce({ ok: false, reason: 'bootstrap-consumed' });

    expect(await checkAgentDispatchPolicy('ws', worker)).toMatchObject({
      ok: false,
      error: 'agent-model-unverified',
    });
    expect(await checkAgentDispatchPolicy(
      'ws',
      worker,
      { consumeBootstrapForTarget: true },
    )).toEqual({ ok: true });
    expect(await checkAgentDispatchPolicy(
      'ws',
      worker,
      { consumeBootstrapForTarget: true },
    )).toMatchObject({ ok: false, error: 'agent-model-unverified' });
  });

  it('retains the consumed bootstrap claim across in-memory policy reset', async () => {
    mocks.workspace.mockResolvedValue({ orchestration: { enabled: false } });
    mocks.model.mockResolvedValue(modelStatus('unknown', 'awaiting-first-turn'));
    const worker = tab('worker');
    mocks.claim
      .mockResolvedValueOnce({ ok: true, generation: 'generation-1' })
      .mockResolvedValueOnce({ ok: false, reason: 'bootstrap-consumed' });

    expect(await checkAgentDispatchPolicy(
      'ws',
      worker,
      { consumeBootstrapForTarget: true },
    )).toEqual({ ok: true });
    clearAgentDispatchPolicyState();

    expect(await checkAgentDispatchPolicy(
      'ws',
      worker,
      { consumeBootstrapForTarget: true },
    )).toMatchObject({ ok: false, error: 'agent-model-unverified' });
  });

  it('serializes concurrent bootstrap claims so exactly one delivery is allowed', async () => {
    mocks.workspace.mockResolvedValue({ orchestration: { enabled: false } });
    mocks.model.mockResolvedValue(modelStatus('unknown', 'awaiting-first-turn'));
    let consumed = false;
    mocks.claim.mockImplementation(async () => {
      if (consumed) return { ok: false, reason: 'bootstrap-consumed' };
      consumed = true;
      return { ok: true, generation: 'generation-1' };
    });

    const results = await Promise.all([
      checkAgentDispatchPolicy('ws', tab('worker'), { consumeBootstrapForTarget: true }),
      checkAgentDispatchPolicy('ws', tab('worker'), { consumeBootstrapForTarget: true }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(mocks.claim).toHaveBeenCalledTimes(2);
  });

  it('does not consume the target bootstrap while its orchestrator remains unknown', async () => {
    const worker = tab('worker');
    mocks.model.mockImplementation(async (value: ITab) =>
      value.id === 'worker'
        ? modelStatus('unknown', 'awaiting-first-turn')
        : modelStatus('unknown', 'session-unavailable'));

    expect(await checkAgentDispatchPolicy(
      'ws',
      worker,
      { consumeBootstrapForTarget: true },
    )).toMatchObject({ ok: false, tabId: 'root' });
    expect(mocks.claim).not.toHaveBeenCalled();

    mocks.model.mockImplementation(async (value: ITab) =>
      value.id === 'worker'
        ? modelStatus('unknown', 'awaiting-first-turn')
        : modelStatus('match'));
    mocks.claim.mockResolvedValue({ ok: true, generation: 'generation-1' });
    expect(await checkAgentDispatchPolicy(
      'ws',
      worker,
      { consumeBootstrapForTarget: true },
    )).toEqual({ ok: true });
  });

  it('does not require metadata on legacy unpinned tabs', async () => {
    mocks.workspace.mockResolvedValue({ orchestration: { enabled: false } });
    const legacy = tab('worker');
    delete legacy.agentLaunchConfig;
    mocks.find.mockResolvedValue({ workspaceId: 'ws', paneId: 'pane-1', tab: legacy });
    mocks.model.mockResolvedValue({
      ...modelStatus('unpinned'),
      expected: { model: null, effort: null },
    });

    expect(await checkAgentDispatchPolicy('ws', legacy)).toEqual({ ok: true });
    expect(mocks.model).toHaveBeenCalledOnce();
  });
});
