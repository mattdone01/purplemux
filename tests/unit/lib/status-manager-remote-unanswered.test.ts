import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITabStatusEntry } from '@/types/status';
import type { TCliState } from '@/types/timeline';
import type { ITab } from '@/types/terminal';

// vel-D61: the watchdog told the orchestrator "worker … is INACTIVE (agent process gone). Respawn the tab"
// for remote tabs whose claude was alive, over a link where one ssh took 18-25 s. ADR-0022 §19: a scan that did
// not read the host is unknown, and no inactive transition acts on the tab. Here the real pane scan, the real
// process proof and the real ssh error classification run; only the ssh process itself is simulated.

const SESSION = 'pt-ws-1-pane-a-tab-r';
const HOST = 'agent-exec-harness';

type TReply = { stdout?: string; stderr?: string; code?: number | null; killed?: boolean; signal?: string };
interface ISshCall { remote: string; input?: string }

const ssh = vi.hoisted(() => ({
  calls: [] as ISshCall[],
  scan: (): TReply => ({ killed: true, code: null, signal: 'SIGTERM' }),
  proof: (): TReply => ({ killed: true, code: null, signal: 'SIGTERM' }),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  type TCallback = (err: Error | null, stdout: string, stderr: string) => void;
  const execFile = (cmd: string, args: string[], _opts: unknown, cb: TCallback) => {
    let reply: TReply = { code: 1, stderr: 'no server running on /tmp/tmux-0/purple' };
    const call: ISshCall = { remote: '' };
    if (cmd === 'ssh') {
      call.remote = args[args.indexOf('--') + 2] ?? '';
      ssh.calls.push(call);
      reply = call.remote.includes("'list-panes' '-a'") ? ssh.scan()
        : call.remote.startsWith("'sh' '-s'") ? ssh.proof()
          : { killed: true, code: null, signal: 'SIGTERM' };
    }
    queueMicrotask(() => {
      if (reply.code !== undefined || reply.killed) {
        const err = Object.assign(new Error('failed'), { code: reply.code, killed: !!reply.killed, signal: reply.signal ?? null });
        cb(err, reply.stdout ?? '', reply.stderr ?? '');
      } else {
        cb(null, reply.stdout ?? '', reply.stderr ?? '');
      }
    });
    return { stdin: { on: () => {}, end: (input: string) => { call.input = input; } } };
  };
  Object.assign(execFile, {
    [promisify.custom]: (cmd: string, args: string[], opts: unknown) => new Promise((resolve, reject) => {
      execFile(cmd, args, opts, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
    }),
  });
  return { ...actual, default: { ...actual, execFile }, execFile };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, hostname: () => 'mdserver1' }, hostname: () => 'mdserver1' };
});

const state = vi.hoisted(() => ({ tab: null as ITab | null }));

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
  findTabBySessionName: vi.fn(async () => state.tab),
  updateTabCliStatus: vi.fn(async () => {}),
  updateTabAgentSummary: vi.fn(async () => {}),
}));
vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => ({ tick: vi.fn(async () => {}), removeTab: vi.fn(), statusForTab: vi.fn(async () => ({ probes: [], backgroundJobs: [] })) }),
}));
vi.mock('@/lib/lease-sweeper', () => ({ getLeaseSweeper: () => ({ sweep: vi.fn(async () => []) }), setLeaseAgentStateSource: vi.fn() }));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));
vi.mock('@/lib/fcm-channel', () => ({ registerFcmChannel: vi.fn() }));
vi.mock('@/lib/session-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session-host')>()),
  sessionHostOf: async (s: string) => (s === SESSION ? HOST : null),
  knownRemoteHosts: () => [HOST],
  remoteHostsInUse: async () => [HOST],
}));

await Promise.all([
  import('@/lib/providers'),
  import('@/lib/status-manager'),
]);

const scanBackoff = () => (globalThis as unknown as { __ptRemoteScanBackoff?: Map<string, number> }).__ptRemoteScanBackoff;
const pane = (command: string): TReply => ({ stdout: `${SESSION}\t${command}\t/home/agent\t4242\t1794200000\n` });
const TIMED_OUT: TReply = { killed: true, code: null, signal: 'SIGTERM' };
const SSH_255: TReply = { code: 255, stderr: 'kex_exchange_identification: read: Connection reset by peer' };

describe('a remote claude tab and a host that does not answer (vel-D61, ADR-0022 §19)', () => {
  const T0 = new Date('2026-11-09T04:44:00Z').getTime();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    scanBackoff()?.clear();
    ssh.calls = [];
    ssh.scan = () => TIMED_OUT;
    ssh.proof = () => TIMED_OUT;
    state.tab = { id: 'tab-r', name: 'builder', order: 0, sessionName: SESSION, panelType: 'claude-code', host: HOST };
  });
  afterEach(() => vi.useRealTimers());

  const setup = async (cliState: TCliState) => {
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(undefined, vi.fn(async () => true), vi.fn(async () => {}));
    manager.registerTab('tab-r', {
      cliState, workspaceId: 'ws-1', tabName: 'builder', tmuxSession: SESSION, panelType: 'claude-code',
      lastEvent: { name: 'prompt-submit', at: T0 - 30 * 60_000, seq: 1 }, eventSeq: 1,
    });
    const entry = (manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs.get('tab-r')!;
    entry.paneTitle = 'claude|/home/agent';
    entry.currentProcess = 'claude';
    const nudges = vi.spyOn(manager as unknown as { nudgeOrchestrator: (...a: unknown[]) => Promise<boolean> }, 'nudgeOrchestrator')
      .mockResolvedValue(true);
    const inactiveNudges = () => nudges.mock.calls.filter((c) => c[2] === 'inactive');
    return { manager, entry, inactiveNudges };
  };

  /** Polls across the 30 s backoff, so both a fresh failed scan and a skipped host are seen. */
  const pollAcrossBackoff = async (manager: { poll: () => Promise<void> }) => {
    for (const offset of [0, 10_000, 31_000, 62_000, 93_000]) {
      vi.setSystemTime(T0 + offset);
      await manager.poll();
    }
  };

  for (const cliState of ['idle', 'ready-for-review', 'needs-input', 'busy'] as const) {
    it(`a ${cliState} tab keeps ${cliState} and sends no inactive nudge while every scan times out`, async () => {
      const { manager, entry, inactiveNudges } = await setup(cliState);
      await pollAcrossBackoff(manager);
      expect(entry.cliState).toBe(cliState);
      expect(entry.paneTitle).toBe('claude|/home/agent');
      expect(inactiveNudges()).toEqual([]);
      expect(ssh.calls.some((c) => c.remote.includes("'list-panes' '-a'"))).toBe(true);
    });
  }

  it('ssh exit 255 is unknown too: no transition, no nudge', async () => {
    ssh.scan = () => SSH_255;
    ssh.proof = () => SSH_255;
    const { manager, entry, inactiveNudges } = await setup('ready-for-review');
    await pollAcrossBackoff(manager);
    expect(entry.cliState).toBe('ready-for-review');
    expect(inactiveNudges()).toEqual([]);
  });

  it('a host that answered once and then times out keeps the tab as it was', async () => {
    let answered = false;
    ssh.scan = () => (answered ? TIMED_OUT : ((answered = true), pane('claude')));
    const { manager, entry, inactiveNudges } = await setup('idle');
    await pollAcrossBackoff(manager);
    expect(entry.cliState).toBe('idle');
    expect(inactiveNudges()).toEqual([]);
  });

  describe('an answered scan whose foreground command is not claude', () => {
    for (const command of ['node', '2.1.319', 'bash']) {
      it(`(${command}) with claude proven in the pane on the host: no inactive transition`, async () => {
        ssh.scan = () => pane(command);
        ssh.proof = () => ({ stdout: 'present\t%3\t4242\t4300\t918273\n' });
        const { manager, entry, inactiveNudges } = await setup('ready-for-review');
        await pollAcrossBackoff(manager);
        expect(entry.cliState).toBe('ready-for-review');
        expect(inactiveNudges()).toEqual([]);
        expect(ssh.calls.some((c) => c.input?.includes('task/*/children'))).toBe(true);
      });
    }

    it('with a process proof that times out: unknown, no transition', async () => {
      ssh.scan = () => pane('bash');
      ssh.proof = () => TIMED_OUT;
      const { manager, entry, inactiveNudges } = await setup('idle');
      await pollAcrossBackoff(manager);
      expect(entry.cliState).toBe('idle');
      expect(inactiveNudges()).toEqual([]);
    });

    it('with a proof that the host answered and that names no claude process: inactive, one nudge', async () => {
      ssh.scan = () => pane('bash');
      ssh.proof = () => ({ stdout: 'absent\tno claude process in the pane\n' });
      const { manager, entry, inactiveNudges } = await setup('idle');
      await manager.poll();
      expect(entry.cliState).toBe('inactive');
      expect(inactiveNudges()).toHaveLength(1);
    });
  });

  it('an answered scan without the session is absence: inactive, one nudge that names the host and the check', async () => {
    ssh.scan = () => ({ stdout: '' });
    const { manager, entry, inactiveNudges } = await setup('idle');
    await manager.poll();
    expect(entry.cliState).toBe('inactive');
    expect(inactiveNudges()).toHaveLength(1);
    const detail = String(inactiveNudges()[0][3]);
    expect(detail).toContain(HOST);
    expect(detail).toContain('purplemux tab status -w ws-1 tab-r');
    expect(detail).toContain('agentProcess "absent"');
    const { buildNudgeMessage } = await import('@/lib/orchestration');
    expect(buildNudgeMessage('inactive', 'tab-r', 'builder', 'ws-1', detail)).toMatch(/is INACTIVE \(agent process gone\)\. Respawn the tab or mark its task blocked\. It runs on agent-exec-harness/);
  });

  it('tmux on the host says no server: absence, inactive', async () => {
    ssh.scan = () => ({ code: 1, stderr: 'no server running on /tmp/tmux-1002/pmux-mdserver1\n' });
    const { manager, entry, inactiveNudges } = await setup('ready-for-review');
    await manager.poll();
    expect(entry.cliState).toBe('inactive');
    expect(inactiveNudges()).toHaveLength(1);
  });

  it('a claude foreground on an answered scan needs no process proof', async () => {
    ssh.scan = () => pane('claude');
    const { manager, entry } = await setup('idle');
    await manager.poll();
    expect(entry.cliState).toBe('idle');
    expect(ssh.calls.some((c) => c.input?.includes('task/*/children'))).toBe(false);
  });
});

describe('the orchestrator prompt and nudge for a remote INACTIVE (vel-D61)', () => {
  it('the kickoff tells the orchestrator to prove a remote tab dead before a respawn', async () => {
    const { DEFAULT_KICKOFF_TEMPLATE, resolveKickoffTemplate } = await import('@/lib/orchestration');
    const text = resolveKickoffTemplate(DEFAULT_KICKOFF_TEMPLATE, { workspaceId: 'ws-1', workspaceName: 'w' });
    const line = text.split('\n').find((l) => l.startsWith('- INACTIVE/DEAD:'))!;
    expect(line).toContain('A REMOTE tab');
    expect(line).toContain('purplemux tab status -w ws-1 <tabId>');
    expect(line).toContain('alive false or agentProcess "absent"');
    expect(line).toMatch(/On agentProcess "unknown" or exit 6 \(remote-host-unreachable\), do NOT respawn/);
  });

  it('a local tab\'s inactive nudge is unchanged', async () => {
    const { buildNudgeMessage } = await import('@/lib/orchestration');
    expect(buildNudgeMessage('inactive', 'tab-l', 'l', 'ws-1')).toBe('[orchestrator-watchdog] worker tab-l (l) is INACTIVE (agent process gone). Respawn the tab or mark its task blocked.');
  });
});
