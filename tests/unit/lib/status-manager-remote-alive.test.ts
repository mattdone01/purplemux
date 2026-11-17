import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPaneInfo } from '@/lib/tmux';
import type { IRemoteProofRequest, RemoteProofScheduler } from '@/lib/remote-proof-scheduler';
import type { ITab } from '@/types/terminal';
import { memoryLedgerTables } from './tab-events-harness';
import '@/lib/providers';

// ADR-0049 §6: Mission Control discovery reads a remote tab's `alive` by the poll's own rule over the pane scan it
// already holds: the provider in the foreground, or a kept `present` proof read without consuming it. No ssh of its
// own, and never the cached CLI state (ADR-0021).

const fixture = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock('@/lib/tmux', async (original) => ({
  ...(await original<typeof import('@/lib/tmux')>()),
  observeRemoteProviderProcess: fixture.observe,
}));

const SESSION = 'pt-ws-a-pane-a-tab-r';
const tab: ITab = { id: 'tab-r', name: 'lead', order: 0, sessionName: SESSION, panelType: 'claude-code', host: 'host-a' };
const pane = (command: string): IPaneInfo => ({ command, path: '/repo', pid: 0, windowActivity: 0, host: 'host-a', paneRef: '%7' });
/** The proof key the poll uses: session, pane, foreground command, launch stamp (none here). */
const proofReq = (command: string): IRemoteProofRequest => ({ tabId: 'tab-r', host: 'host-a', sessionName: SESSION, want: 'claude', key: `${SESSION}\t%7\t${command}\t` });

const make = async () => {
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(undefined, undefined, undefined, ...memoryLedgerTables());
  const proofs = (manager as unknown as { remoteProofs: RemoteProofScheduler }).remoteProofs;
  return { manager, proofs };
};

describe('remote agent alive for Mission Control discovery', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('the provider in the foreground is alive, with no ssh', async () => {
    const { manager } = await make();
    expect(await manager.remoteAgentAlive(tab, pane('claude'))).toBe(true);
    expect(fixture.observe).not.toHaveBeenCalled();
  });

  it('another foreground is alive only on a kept present proof for the current pane', async () => {
    const { manager, proofs } = await make();
    expect(await manager.remoteAgentAlive(tab, pane('node'))).toBe(false);
    expect(fixture.observe).not.toHaveBeenCalled();
    fixture.observe.mockResolvedValue({ state: 'present', identity: 'remote:x' });
    await proofs.schedule([proofReq('node')]);
    expect(await manager.remoteAgentAlive(tab, pane('node'))).toBe(true);
    expect(await manager.remoteAgentAlive(tab, pane('bash'))).toBe(false);
  });

  it('a cached busy state alone is not alive', async () => {
    const { manager } = await make();
    manager.registerTab('tab-r', { cliState: 'busy', workspaceId: 'ws-a', tabName: 'lead', tmuxSession: SESSION, panelType: 'claude-code', agentProviderId: 'claude' });
    expect(await manager.remoteAgentAlive(tab, pane('node'))).toBe(false);
  });

  it('an absent proof reads not alive and is left for the poll to take', async () => {
    const { manager, proofs } = await make();
    fixture.observe.mockResolvedValue({ state: 'absent', reason: 'no claude process in the pane' });
    await proofs.schedule([proofReq('node')]);
    expect(await manager.remoteAgentAlive(tab, pane('node'))).toBe(false);
    expect(proofs.read(proofReq('node'))).toBe(false);
  });

  it('no pane in the scan, or a local tab, is not alive', async () => {
    const { manager } = await make();
    expect(await manager.remoteAgentAlive(tab, undefined)).toBe(false);
    expect(await manager.remoteAgentAlive({ ...tab, host: undefined }, pane('claude'))).toBe(false);
  });
});
