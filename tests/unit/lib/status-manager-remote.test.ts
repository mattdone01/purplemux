import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// ADR-0022 §11: a remote terminal pane has no local pid. Its status is its foreground command
// alone (shell idle, anything else running); no port scan, no process walk runs on its pid.

// `listing`: an answered scan that lists other sessions of the host (tmux still runs there); without it, an answered
// scan that misses the pane is tmux's "no server" answer. `failure`: the ssh error of an unread scan.
const SSH_REFUSED = 'exit 255: ssh: connect to host ai-server port 22: Connection refused';
const state = vi.hoisted(() => ({ command: 'bash', tab: null as ITab | null, pane: true, answered: true, listing: false, failure: '' }));
const tmux = vi.hoisted(() => ({ getListeningPorts: vi.fn(async () => [8080]), getChildPids: vi.fn(async () => []) }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: vi.fn(async () => ({ workspaces: [{ id: 'ws-1', name: 'w', directories: ['/tmp'] }] })),
  getWorkspaceByIdCached: vi.fn(async () => undefined),
  getWorkspacesCached: vi.fn(async () => ({ workspaces: [] })),
}));
vi.mock('@/lib/layout-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/layout-store')>()),
  resolveLayoutFile: () => '/nonexistent/layout.json',
  readLayoutFile: vi.fn(async () => ({ root: {} })),
  collectAllTabs: () => (state.tab ? [state.tab] : []),
  updateTabCliStatus: vi.fn(async () => {}),
  updateTabAgentSummary: vi.fn(async () => {}),
}));
vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => ({ tick: vi.fn(async () => {}), removeTab: vi.fn(), statusForTab: vi.fn(async () => ({ probes: [], backgroundJobs: [] })) }),
}));
vi.mock('@/lib/lease-sweeper', () => ({ getLeaseSweeper: () => ({ sweep: vi.fn(async () => []) }), setLeaseAgentStateSource: vi.fn() }));
vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux')>()),
  getAllPanesInfo: vi.fn(async () => Object.assign(
    new Map([
      ...(state.pane ? [['pt-ws-1-pane-a-tab-r', { pid: 0, command: state.command, path: '/home/mdone', windowActivity: 0, host: 'ai-server' }] as const] : []),
      ...(state.answered && state.listing ? [['pt-ws-9-pane-z-tab-z', { pid: 0, command: 'claude', path: '/home/mdone', windowActivity: 0, host: 'ai-server' }] as const] : []),
    ]),
    {
      answeredRemoteHosts: new Set(state.answered ? ['ai-server'] : []),
      unreadRemoteHosts: new Map(state.answered ? [] : [['ai-server', state.failure || 'not read']]),
      serverAbsentRemoteHosts: new Set(state.answered && !state.pane && !state.listing ? ['ai-server'] : []),
    },
  )),
  getListeningPorts: tmux.getListeningPorts,
  getChildPids: tmux.getChildPids,
  getPaneTitle: vi.fn(async () => ''),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));
vi.mock('@/lib/fcm-channel', () => ({ registerFcmChannel: vi.fn() }));
vi.mock('@/lib/session-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session-host')>()),
  sessionHostOf: async (s: string) => (s === 'pt-ws-1-pane-a-tab-r' ? 'ai-server' : null),
}));

// The first load of this module graph costs about 1 s alone and passed the 5 s test budget on a loaded gate
// (story hfl2-53). Load it once here, at collection, outside every test's budget. vi.resetModules() discards
// this instance; each test's own import evaluates again from the transform cache in milliseconds.
await Promise.all([
  import('@/lib/providers'),
  import('@/lib/status-manager'),
]);

describe('status of a remote terminal tab (ADR-0022 §11)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.tab = { id: 'tab-r', name: 'r', order: 0, sessionName: 'pt-ws-1-pane-a-tab-r', panelType: 'terminal', host: 'ai-server' };
  });
  afterEach(() => { state.command = 'bash'; state.pane = true; state.answered = true; state.listing = false; state.failure = ''; });

  const poll = async () => {
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(undefined, vi.fn(async () => true), vi.fn(async () => {}));
    manager.registerTab('tab-r', { cliState: 'inactive', workspaceId: 'ws-1', tabName: 'r', tmuxSession: 'pt-ws-1-pane-a-tab-r', panelType: 'terminal', lastEvent: null, eventSeq: 0 });
    await manager.poll();
    return (manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs.get('tab-r')!;
  };

  it('a shell in the foreground is idle', async () => {
    expect((await poll()).terminalStatus).toBe('idle');
  });

  it('any other foreground command is running, and its pid is never scanned for ports', async () => {
    state.command = 'vim';
    const entry = await poll();
    expect(entry.terminalStatus).toBe('running');
    expect(entry.listeningPorts).toEqual([]);
    expect(tmux.getListeningPorts).not.toHaveBeenCalled();
  });

  describe('a remote Claude tab whose pane is unread (review r3 B1)', () => {
    const T0 = new Date('2026-10-10T12:00:00Z').getTime();
    const setupAgent = async (cliState: 'busy' | 'ready-for-review' | 'unknown') => {
      state.tab = { id: 'tab-r', name: 'r', order: 0, sessionName: 'pt-ws-1-pane-a-tab-r', panelType: 'claude-code', host: 'ai-server' };
      await import('@/lib/providers');
      const { StatusManager } = await import('@/lib/status-manager');
      const manager = new StatusManager(undefined, vi.fn(async () => true), vi.fn(async () => {}));
      manager.registerTab('tab-r', {
        cliState, workspaceId: 'ws-1', tabName: 'r', tmuxSession: 'pt-ws-1-pane-a-tab-r', panelType: 'claude-code',
        lastEvent: { name: 'prompt-submit', at: T0 - 30 * 60_000, seq: 1 }, eventSeq: 1,
      });
      const entry = (manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs.get('tab-r')!;
      entry.paneTitle = 'claude|/home/mdone';
      return { manager, entry };
    };
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0); });
    afterEach(() => vi.useRealTimers());

    it('a busy tab keeps busy for a missed scan and for the backoff, and the 10 min force never fires', async () => {
      state.pane = false;
      state.answered = false;
      const { manager, entry } = await setupAgent('busy');
      await manager.poll();
      expect(entry.cliState).toBe('busy');
      vi.setSystemTime(T0 + 20_000);
      await manager.poll();
      expect(entry.cliState).toBe('busy');
      expect(entry.paneTitle).toBe('claude|/home/mdone');
    });

    it('a ready-for-review tab is not made inactive while its pane is unread', async () => {
      state.pane = false;
      state.answered = false;
      const { manager, entry } = await setupAgent('ready-for-review');
      vi.setSystemTime(T0 + 60_000);
      await manager.poll();
      expect(entry.cliState).toBe('ready-for-review');
    });

    it('an answered scan without the session, twice in a row, is real absence: the busy tab is forced idle as a local one would be', async () => {
      state.pane = false;
      state.answered = true;
      const { manager, entry } = await setupAgent('busy');
      await manager.poll();
      // One scan that misses the agent is unknown (story 11 CARRY): the tab keeps busy.
      expect(entry.cliState).toBe('busy');
      await manager.poll();
      expect(entry.cliState).toBe('idle');
    });

    it('one scan that misses a live agent never flips a tab: a sighting between two misses starts the count again (story 11 CARRY)', async () => {
      state.tab = { id: 'tab-r', name: 'r', order: 0, sessionName: 'pt-ws-1-pane-a-tab-r', panelType: 'claude-code', host: 'ai-server' };
      const { manager, entry } = await setupAgent('ready-for-review');
      vi.setSystemTime(T0 + 60_000);
      state.answered = true;
      for (const seen of [false, true, false]) {
        state.pane = seen;
        state.command = 'claude';
        await manager.poll();
        expect(entry.cliState).toBe('ready-for-review');
      }
      state.pane = false;
      await manager.poll();
      expect(entry.cliState).toBe('inactive');
    });

    const served = (manager: unknown) => (manager as { getAllForClient: () => Record<string, { cliState: string; remoteUnreachable?: unknown }> }).getAllForClient()['tab-r'];

    it('a busy tab on a host unread two polls in a row serves unknown with the ssh error, and its own state once read (story 11 r1, finding 3)', async () => {
      state.pane = false;
      state.answered = false;
      state.failure = SSH_REFUSED;
      const { manager, entry } = await setupAgent('busy');
      const broadcast = vi.spyOn(manager as unknown as { broadcast: (event: object) => void }, 'broadcast');
      await manager.poll();
      expect(served(manager)).toMatchObject({ cliState: 'busy', remoteUnreachable: null });
      vi.setSystemTime(T0 + 20_000);
      await manager.poll();
      expect(served(manager)).toEqual(expect.objectContaining({
        cliState: 'unknown',
        remoteUnreachable: { host: 'ai-server', error: SSH_REFUSED, since: T0 },
      }));
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'status:update', tabId: 'tab-r', cliState: 'unknown', remoteUnreachable: expect.objectContaining({ error: SSH_REFUSED }) }), undefined);
      // Only what is served changes: the state underneath, and every transition on it, is as it was.
      expect(entry.cliState).toBe('busy');
      state.pane = true;
      state.answered = true;
      state.command = 'claude';
      vi.setSystemTime(T0 + 40_000);
      broadcast.mockClear();
      await manager.poll();
      expect(served(manager)).toMatchObject({ cliState: 'busy', remoteUnreachable: null });
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-r', cliState: 'busy', remoteUnreachable: null }), undefined);
    });

    it('one unread poll between read ones never serves unknown (finding 3)', async () => {
      state.command = 'claude';
      const { manager } = await setupAgent('busy');
      for (const answered of [true, false, true, false]) {
        state.answered = answered;
        state.pane = answered;
        await manager.poll();
        expect(served(manager).cliState).toBe('busy');
      }
    });

    it('answered scans that list none of the sessions the host showed before read as unread, scan after scan, until three agree (story 11 r1, finding 4)', async () => {
      state.command = 'claude';
      const { manager, entry } = await setupAgent('ready-for-review');
      vi.setSystemTime(T0 + 60_000);
      await manager.poll();
      // tmux still runs on the host and lists another session: the repeated partial answer the 08:18Z poll may have been.
      state.pane = false;
      state.listing = true;
      await manager.poll();
      await manager.poll();
      expect(entry.cliState).toBe('ready-for-review');
      expect(served(manager)).toEqual(expect.objectContaining({
        cliState: 'unknown',
        remoteUnreachable: expect.objectContaining({ error: expect.stringContaining('the scan answered without any of the 1 sessions it showed before') }),
      }));
      // The third such scan is believed; the agent-gone guard still wants a second miss in a row.
      await manager.poll();
      expect(entry.cliState).toBe('ready-for-review');
      await manager.poll();
      expect(entry.cliState).toBe('inactive');
    });

    it('a scan that keeps one of the sessions it showed before is believed for the others at once (finding 4)', async () => {
      state.command = 'claude';
      const { manager, entry } = await setupAgent('ready-for-review');
      const reviewer = manager as unknown as { remoteHostSeenSessions: Map<string, Set<string>>; tabs: Map<string, ITabStatusEntry> };
      vi.setSystemTime(T0 + 60_000);
      await manager.poll();
      reviewer.remoteHostSeenSessions.get('ai-server')!.add('pt-ws-9-pane-z-tab-z');
      reviewer.tabs.set('tab-z', { ...entry, tmuxSession: 'pt-ws-9-pane-z-tab-z' });
      state.pane = false;
      state.listing = true;
      await manager.poll();
      await manager.poll();
      expect(entry.cliState).toBe('inactive');
    });

    it('resolveUnknown keeps a remote tab unknown while its host is unread, and resolves it once the pane reads', async () => {
      state.pane = false;
      state.answered = false;
      const { manager, entry } = await setupAgent('unknown');
      await (manager as unknown as { resolveUnknown: (id: string) => Promise<void> }).resolveUnknown('tab-r');
      expect(entry.cliState).toBe('unknown');
      state.answered = true;
      await (manager as unknown as { resolveUnknown: (id: string) => Promise<void> }).resolveUnknown('tab-r');
      expect(entry.cliState).toBe('idle');
    });
  });
});
