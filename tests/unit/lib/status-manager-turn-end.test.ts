import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab, TPanelType } from '@/types/terminal';

const mockHome = vi.hoisted(() => ({ value: '' }));
const workspaceStore = vi.hoisted(() => ({
  getWorkspaceByIdCached: vi.fn(),
  getWorkspacesCached: vi.fn(),
}));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn(), removeTab: vi.fn() }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: workspaceStore.getWorkspaceByIdCached,
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: workspaceStore.getWorkspacesCached,
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => liveness }));
vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux')>()),
  getSessionPanePid: vi.fn(async () => null),
  getSessionCwd: vi.fn(async () => null),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));

const FIXTURES = path.join(__dirname, '../../fixtures');
const BLOCKED = 'BLOCKED: gate red — needs X';

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

const managerWithPaste = async () => {
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  await import('@/lib/providers');
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}));
  manager.registerTab('root', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'root', tmuxSession: 'tmux-root', panelType: 'claude-code' });
  return { manager, paste };
};

const worker = (panelType: TPanelType, jsonlPath: string | null): ITabStatusEntry => ({
  cliState: 'busy',
  workspaceId: 'ws-1',
  tabName: 'w1',
  tmuxSession: 'tmux-worker',
  panelType,
  agentProviderId: panelType === 'codex-cli' ? 'codex' : panelType === 'grok-cli' ? 'grok' : 'claude',
  jsonlPath,
  lastEvent: { name: 'prompt-submit', at: Date.now(), seq: 1 },
  eventSeq: 1,
});

const writeLines = async (name: string, lines: unknown[]): Promise<string> => {
  const file = path.join(mockHome.value, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
};

const claudeEnd = (text: string) => ({
  type: 'assistant',
  timestamp: '2026-09-26T05:00:00.000Z',
  message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
});

// Gate lanes run four vitest workers on a loaded host; 1 s (the default) flaked there.
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 5000 });

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('stop classification (ADR-0018)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-turn-end-'));
    const ws = { id: 'ws-1', name: 'ws', directories: [mockHome.value], orchestration: { enabled: true, orchestratorTabId: 'root' } };
    workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
    workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const transcripts: Array<[TPanelType, () => Promise<string>]> = [
    ['claude-code', () => writeLines('claude/s.jsonl', [claudeEnd(`Gate r2 failed on lint.\n\n${BLOCKED}`)])],
    ['codex-cli', () => writeLines('codex/s.jsonl', [
      { timestamp: '2026-09-26T05:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      { timestamp: '2026-09-26T05:01:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: `Gate r2 failed on lint.\n\n${BLOCKED}` } },
      { timestamp: '2026-09-26T05:01:01.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
    ])],
    ['grok-cli', async () => {
      const raw = await fs.readFile(path.join(FIXTURES, 'grok-session/updates.jsonl'), 'utf-8');
      const replaced = raw.replace('"text":"OK"', `"text":${JSON.stringify(`Gate r2 failed on lint.\n\n${BLOCKED}`)}`);
      expect(replaced).not.toBe(raw);
      return writeLines('grok/updates.jsonl', replaced.trim().split('\n'));
    }],
  ];

  it.each(transcripts)('sends the %s worker\'s BLOCKED line verbatim to the orchestrator', async (panelType, make) => {
    const { manager, paste } = await managerWithPaste();
    const entry = worker(panelType, await make());
    manager.registerTab('worker', entry);

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));

    expect(paste).toHaveBeenCalledWith(
      'tmux-root',
      `[orchestrator-watchdog] worker worker (w1) ended: ${BLOCKED} — read with: purplemux tab result -w ws-1 worker`,
    );
    expect(entry.cliState).toBe('ready-for-review');
    expect(entry.turnEnd).toMatchObject({ kind: 'turn-marker', marker: [BLOCKED] });
    expect(manager.getOrchestrationNudges('ws-1')).toEqual([expect.objectContaining({ kind: 'turn-marker', tabId: 'worker' })]);
  });

  it('holds the recorded "Waiting for 1 background agent" stop whose shell started 20 turns earlier', async () => {
    const { manager, paste } = await managerWithPaste();
    const shapes = (await fs.readFile(path.join(FIXTURES, 'claude-background/shapes-2.1.283.jsonl'), 'utf-8')).trim().split('\n');
    const start = shapes.find((l) => l.includes('"backgroundTaskId": "bshell01"'))!;
    const turns = Array.from({ length: 20 }, (_, i) => claudeEnd(`turn ${i}: ${'x'.repeat(3000)}`));
    const file = await writeLines('claude/wait.jsonl', [start, ...turns, claudeEnd('Gate r1 is running.\n\nWaiting for 1 background agent')]);
    const entry = worker('claude-code', file);
    manager.registerTab('worker', entry);

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('waiting'));
    await settle();

    expect(paste).not.toHaveBeenCalled();
    expect(entry.cliState).toBe('busy');
    expect(entry.turnEnd).toMatchObject({ openBackgroundTasks: 1, liveRegisteredJobs: 0 });
  });

  it('holds a stop with no marker while a registered tab bg job is alive', async () => {
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: true, registeredAt: 0, ageS: 1 }] });
    const { manager, paste } = await managerWithPaste();
    const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('Gate running.')]));
    manager.registerTab('worker', entry);

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('waiting'));
    await settle();

    expect(paste).not.toHaveBeenCalled();
    expect(entry.turnEnd).toMatchObject({ openBackgroundTasks: 0, liveRegisteredJobs: 1 });
  });

  it('sends today\'s READY FOR REVIEW nudge unchanged when there is no marker and nothing open', async () => {
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: false, registeredAt: 0, ageS: 1 }] });
    const { manager, paste } = await managerWithPaste();
    const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('All set.')]));
    manager.registerTab('worker', entry);

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));

    const { buildNudgeMessage } = await import('@/lib/orchestration');
    expect(paste).toHaveBeenCalledWith('tmux-root', buildNudgeMessage('ready-for-review', 'worker', 'w1', 'ws-1'));
    expect(entry.turnEnd?.kind).toBe('ready-for-review');
  });

  it('falls back to READY FOR REVIEW without a transcript and logs the fallback once per tab', async () => {
    const { manager, paste } = await managerWithPaste();
    const entry = worker('claude-code', null);
    manager.registerTab('worker', entry);
    const fallback = (manager as unknown as { transcriptFallbackLogged: Set<string> }).transcriptFallbackLogged;

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
    expect(paste.mock.calls[0][1]).toContain('is READY FOR REVIEW');
    expect(fallback.has('worker')).toBe(true);
  });

  it('lets only the newest of two quick stops classify the tab (stop → prompt-submit → stop)', async () => {
    const { manager, paste } = await managerWithPaste();
    const { getProviderByPanelType } = await import('@/lib/providers/registry');
    const claude = getProviderByPanelType('claude-code')!;
    const original = claude.readRuntimeSnapshot.bind(claude);
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let reads = 0;
    // Classification reads carry `tasksSince`; the snippet refresh does not. Both
    // stops run the same async chain, so the first classification read is stop 1's.
    const read = vi.spyOn(claude, 'readRuntimeSnapshot').mockImplementation(async (handle, options) => {
      if (!options || !('tasksSince' in options)) return original(handle, options);
      reads += 1;
      if (reads === 1) {
        await firstRead;
        return { ...(await original(handle, options)), lastAssistantTail: 'Waiting on the gate.', openBackgroundTasks: 1 };
      }
      return original(handle, options);
    });
    try {
      const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('All set.')]));
      manager.registerTab('worker', entry);

      manager.updateTabFromHook('tmux-worker', 'stop');
      manager.updateTabFromHook('tmux-worker', 'prompt-submit');
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      releaseFirst();
      await settle();

      expect(entry.cliState).toBe('ready-for-review');
      expect(entry.turnEnd?.kind).toBe('ready-for-review');
    } finally {
      read.mockRestore();
    }
  });

  it('reports a WAITING tab as at its prompt only for the current stop and until a relaunch (ruling A′)', async () => {
    const { manager } = await managerWithPaste();
    const shapes = (await fs.readFile(path.join(FIXTURES, 'claude-background/shapes-2.1.283.jsonl'), 'utf-8')).trim().split('\n');
    const start = shapes.find((l) => l.includes('"backgroundTaskId": "bshell01"'))!;
    const entry = worker('claude-code', await writeLines('claude/w.jsonl', [start, claudeEnd('Waiting on the gate.')]));
    entry.lastResumeOrStartedAt = Date.now() - 60_000;
    manager.registerTab('worker', entry);
    expect(manager.isWaitingAtPrompt('worker')).toBe(false);

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('waiting'));
    expect(entry.turnEnd?.seq).toBe(entry.lastEvent?.seq);
    expect(manager.isWaitingAtPrompt('worker')).toBe(true);

    manager.markAgentLaunch('worker');
    expect(manager.isWaitingAtPrompt('worker')).toBe(false);
    entry.lastResumeOrStartedAt = entry.lastEvent!.at - 1;
    expect(manager.isWaitingAtPrompt('worker')).toBe(true);

    manager.updateTabFromHook('tmux-worker', 'prompt-submit');
    expect(manager.isWaitingAtPrompt('worker')).toBe(false);
    expect(manager.isWaitingAtPrompt('nope')).toBe(false);
  });

  it('drops a stale classification when a newer event moved the tab on', async () => {
    const { manager, paste } = await managerWithPaste();
    const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('DONE: x')]));
    manager.registerTab('worker', entry);

    manager.updateTabFromHook('tmux-worker', 'stop');
    manager.updateTabFromHook('tmux-worker', 'prompt-submit');
    await settle();

    expect(paste).not.toHaveBeenCalled();
    expect(entry.cliState).toBe('busy');
  });
});

describe('busy-stuck check for a waiting tab (ADR-0018, L19, L25)', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-stuck-'));
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const looksStalled = async (entry: ITabStatusEntry, now: number) => {
    const { manager } = await managerWithPaste();
    return (manager as unknown as { looksStalled: (id: string, e: ITabStatusEntry, n: number) => Promise<boolean> }).looksStalled('worker', entry, now);
  };

  const setMtime = (file: string, at: number) => fs.utimes(file, new Date(at), new Date(at));

  const shellWait = async (startedAt: number) => {
    const out = path.join(mockHome.value, 'tasks', 'bgate.output');
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, '');
    const file = await writeLines('claude/s.jsonl', [
      {
        type: 'user',
        timestamp: new Date(startedAt).toISOString(),
        message: { content: [{ type: 'tool_result', content: `Command running in background with ID: bgate. Output is being written to: ${out}. You will be notified` }] },
        toolUseResult: { backgroundTaskId: 'bgate' },
      },
      { ...claudeEnd('Waiting for the gate.'), timestamp: new Date(startedAt).toISOString() },
    ]);
    await setMtime(file, startedAt);
    await setMtime(out, startedAt);
    return { file, out };
  };

  it('is not STALLED 20 min into a wait, nor past the backstop while the task-output file keeps growing', async () => {
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const { file, out } = await shellWait(t0);
    await fs.appendFile(out, 'lane 3 passed\n');
    await setMtime(out, t0 + 19 * 60 * 1000);
    expect(await looksStalled(worker('claude-code', file), t0 + 20 * 60 * 1000)).toBe(false);
    await setMtime(out, t0 + 94 * 60 * 1000);
    expect(await looksStalled(worker('claude-code', file), t0 + 95 * 60 * 1000)).toBe(false);
    await setMtime(out, t0);
    expect(await looksStalled(worker('claude-code', file), t0 + 95 * 60 * 1000)).toBe(true);
  });

  it('judges a live registered tab bg job like a silent shell: not STALLED at 40 min, STALLED at the 90 min backstop', async () => {
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: true, registeredAt: 0, ageS: 1 }] });
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const file = await writeLines('claude/j.jsonl', [{ ...claudeEnd('Gate launched; waiting.'), timestamp: new Date(t0).toISOString() }]);
    await setMtime(file, t0);
    expect(await looksStalled(worker('claude-code', file), t0 + 40 * 60 * 1000)).toBe(false);
    expect(await looksStalled(worker('claude-code', file), t0 + 90 * 60 * 1000)).toBe(true);
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: false, registeredAt: 0, ageS: 1 }] });
    expect(await looksStalled(worker('claude-code', file), t0 + 40 * 60 * 1000)).toBe(true);
  });

  it('drops tasks started before the tab\'s Claude process (pid file startedAt flows through)', async () => {
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const { file } = await shellWait(t0);
    const tmux = await import('@/lib/tmux');
    vi.mocked(tmux.getSessionPanePid).mockResolvedValue(4242);
    await import('@/lib/providers');
    const { getProviderByPanelType } = await import('@/lib/providers/registry');
    const claude = getProviderByPanelType('claude-code')!;
    const detect = vi.spyOn(claude, 'detectActiveSession').mockResolvedValue({
      status: 'running', sessionId: 's', jsonlPath: file, pid: 4243, startedAt: t0 + 60_000, cwd: '/',
    });
    try {
      // The shell started before this process: an orphan, so the tab is judged by the no-open 10 min rule.
      expect(await looksStalled(worker('claude-code', file), t0 + 40 * 60 * 1000)).toBe(true);
      expect(detect).toHaveBeenCalledWith(4242, undefined, { tmuxSession: 'tmux-worker' });
    } finally {
      detect.mockRestore();
      vi.mocked(tmux.getSessionPanePid).mockResolvedValue(null);
    }
  });

  it('is not STALLED on a silent gate waiter 40 min in, and is at the 90 min backstop', async () => {
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const { file } = await shellWait(t0);
    expect(await looksStalled(worker('claude-code', file), t0 + 40 * 60 * 1000)).toBe(false);
    expect(await looksStalled(worker('claude-code', file), t0 + 90 * 60 * 1000)).toBe(true);
  });

  it('is STALLED when an open subagent\'s transcript has been silent 15 min', async () => {
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const file = await writeLines('claude/a.jsonl', [
      {
        type: 'user',
        timestamp: new Date(t0).toISOString(),
        message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] },
        toolUseResult: { isAsync: true, agentId: 'aw1' },
      },
    ]);
    const sub = path.join(mockHome.value, 'claude', 'a', 'subagents', 'agent-aw1.jsonl');
    await fs.mkdir(path.dirname(sub), { recursive: true });
    await fs.writeFile(sub, '{}\n');
    await setMtime(file, t0);
    await setMtime(sub, t0 + 5 * 60 * 1000);
    expect(await looksStalled(worker('claude-code', file), t0 + 19 * 60 * 1000)).toBe(false);
    expect(await looksStalled(worker('claude-code', file), t0 + 20 * 60 * 1000)).toBe(true);
  });

  it('keeps the 10 min rule for a busy tab with nothing open', async () => {
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const file = await writeLines('claude/b.jsonl', [{ ...claudeEnd('working'), timestamp: new Date(t0).toISOString() }]);
    expect(await looksStalled(worker('claude-code', file), t0 + 9 * 60 * 1000)).toBe(false);
    expect(await looksStalled(worker('claude-code', file), t0 + 11 * 60 * 1000)).toBe(true);
  });
});
