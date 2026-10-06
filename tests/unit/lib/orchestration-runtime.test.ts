import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITab } from '@/types/terminal';
const fixture = vi.hoisted(() => ({ session: vi.fn(), process: vi.fn(), pending: vi.fn(), model: vi.fn() }));
vi.mock('@/lib/tmux', () => ({ observeSessionStrict: fixture.session }));
vi.mock('@/lib/process-utils', () => ({ observeProviderProcess: fixture.process }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ isOrchestrationLaunchPending: fixture.pending }) }));
vi.mock('@/lib/providers/codex/model-observation', () => ({ getCodexModelStatus: fixture.model }));
import { observeOrchestrationRuntime, candidateModelUsable } from '@/lib/orchestration-runtime';
const tab: ITab = { id: 't', name: 't', order: 0, panelType: 'claude-code', sessionName: 'session-t' };
beforeEach(() => { vi.clearAllMocks(); fixture.pending.mockReturnValue(false); fixture.session.mockResolvedValue({ state: 'present', panePid: 42, identity: 'session:42' }); fixture.process.mockResolvedValue({ state: 'present', identity: '43:100:claude' }); });
describe('strict recovery runtime observations', () => {
  it.each(['absent', 'unknown'])('preserves tmux %s rather than trusting cached status', async (state) => {
    fixture.session.mockResolvedValue({ state, reason: 'observed' });
    expect(await observeOrchestrationRuntime({ ...tab, cliState: 'idle' })).toEqual({ state, reason: 'observed' });
    expect(fixture.process).not.toHaveBeenCalled();
  });
  it.each(['absent', 'unknown'])('preserves provider %s with a live shell', async (state) => {
    fixture.process.mockResolvedValue({ state, reason: 'provider' });
    expect(await observeOrchestrationRuntime(tab)).toEqual({ state, reason: 'provider' });
  });
  it('binds positive evidence to both the current pane and provider process', async () => {
    expect(await observeOrchestrationRuntime(tab)).toEqual({ state: 'present', identity: 'session:42:43:100:claude' });
    expect(fixture.process).toHaveBeenCalledWith(42, 'claude');
  });
  it('pending launch remains unknown without probing an old generation', async () => {
    fixture.pending.mockReturnValue(true);
    expect(await observeOrchestrationRuntime(tab)).toMatchObject({ state: 'unknown' });
    expect(fixture.session).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'mismatch', 'match', 'not-applicable'])('uses existing Codex model proof %s without bootstrap claims', async (status) => {
    fixture.model.mockResolvedValue({ status });
    expect(await candidateModelUsable({ ...tab, panelType: 'codex-cli' })).toBe(!['unknown', 'mismatch'].includes(status));
  });
});
