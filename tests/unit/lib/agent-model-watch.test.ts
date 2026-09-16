import { describe, expect, it, vi } from 'vitest';
import { AgentModelWatch } from '@/lib/agent-model-watch';
import type { ICodexModelStatus } from '@/lib/providers/codex/model-observation';
import type { ITab } from '@/types/terminal';

const tab: ITab = { id: 'root', name: 'root', sessionName: 's', order: 0, panelType: 'codex-cli', agentLaunchConfig: { model: 'astra' } };
const mismatch: ICodexModelStatus = {
  expected: { model: 'astra', effort: null }, status: 'mismatch', latestSettings: null, latestTurn: null,
  observed: { model: 'luna', effort: 'medium', source: 'turn_context', timestamp: '2026-09-10T00:00:00Z', sessionId: 'session' },
};

describe('model drift watchdog episodes', () => {
  it('alerts once despite changing timestamps, then alerts again after recovery', async () => {
    const read = vi.fn(async () => mismatch);
    const notify = vi.fn(async () => true);
    const watch = new AgentModelWatch(read);
    await watch.check(tab, notify);
    read.mockResolvedValue({ ...mismatch, observed: { ...mismatch.observed!, timestamp: '2026-09-10T00:01:00Z' } });
    await watch.check(tab, notify);
    expect(notify).toHaveBeenCalledTimes(1);
    read.mockResolvedValue({ ...mismatch, status: 'match' });
    await watch.check(tab, notify);
    read.mockResolvedValue(mismatch);
    await watch.check(tab, notify);
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it('does not turn missing metadata into a new mismatch episode', async () => {
    const read = vi.fn(async () => mismatch);
    const notify = vi.fn(async () => true);
    const watch = new AgentModelWatch(read);
    await watch.check(tab, notify);
    read.mockResolvedValue({ ...mismatch, status: 'unknown', observed: null });
    await watch.check(tab, notify);
    read.mockResolvedValue(mismatch);
    await watch.check(tab, notify);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('retries a failed notification and isolates two tab identities', async () => {
    const notify = vi.fn(async () => true).mockRejectedValueOnce(new Error('record failed'));
    const watch = new AgentModelWatch(async () => mismatch);
    await expect(watch.check(tab, notify)).rejects.toThrow('record failed');
    await watch.check(tab, notify);
    await watch.check({ ...tab, id: 'worker' }, notify);
    expect(notify).toHaveBeenCalledTimes(3);
  });
  it('latches after a human-visible record even when terminal delivery fails', async () => {
    const notify = vi.fn(async () => true);
    const watch = new AgentModelWatch(async () => mismatch);
    await watch.check(tab, notify);
    await watch.check(tab, notify);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('retries when no human-visible record was created', async () => {
    const notify = vi.fn(async () => false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const watch = new AgentModelWatch(async () => mismatch);
    await watch.check(tab, notify);
    await watch.check(tab, notify);
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it('ignores unpinned and other-engine tabs', async () => {
    const read = vi.fn(async () => mismatch);
    const watch = new AgentModelWatch(read);
    const notify = vi.fn(async () => true);
    await watch.check({ ...tab, agentLaunchConfig: undefined }, notify);
    await watch.check({ ...tab, panelType: 'claude-code' }, notify);
    expect(read).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
