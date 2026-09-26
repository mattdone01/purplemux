import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab, TPanelType } from '@/types/terminal';

const mockHome = vi.hoisted(() => ({ value: '' }));
const workspaceStore = vi.hoisted(() => ({ getWorkspaceByIdCached: vi.fn(), getWorkspacesCached: vi.fn() }));
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
  getAllPanesInfo: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));

const FIXTURES = path.join(__dirname, '../../fixtures/turn-errors');
const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 5000 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

const setup = async () => {
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
  manager.registerTab('tab-o', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'o', tmuxSession: 'tmux-tab-o', panelType: 'claude-code' });
  const store = await import('@/lib/inbox-store');
  const nudges = () => paste.mock.calls.map(([, message]) => message);
  const resumes = async () => (await store.readInboxState()).items.filter((i) => i.kind === 'resume');
  return { manager, paste, nudges, resumes, store };
};

const transcript = async (fixture: string, extra: unknown[] = []): Promise<string> => {
  const file = path.join(mockHome.value, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  await fs.writeFile(file, (await fs.readFile(path.join(FIXTURES, fixture), 'utf-8')) + extra.map((e) => JSON.stringify(e) + '\n').join(''));
  return file;
};

const worker = (panelType: TPanelType, jsonlPath: string): ITabStatusEntry => ({
  cliState: 'busy', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-tab-w', panelType,
  agentProviderId: panelType === 'codex-cli' ? 'codex' : 'claude', jsonlPath,
  lastEvent: { name: 'prompt-submit', at: Date.now(), seq: 1 }, eventSeq: 1,
});

const stopAgain = async (manager: { updateTabFromHook: (s: string, e: string) => void }, entry: ITabStatusEntry, file: string) => {
  entry.jsonlPath = file;
  manager.updateTabFromHook('tmux-tab-w', 'prompt-submit');
  manager.updateTabFromHook('tmux-tab-w', 'stop');
};

describe('API-error turn ends (story 26, ADR-0018 amendment)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-turn-error-sm-'));
    const ws = { id: 'ws-1', name: 'ws', directories: [mockHome.value], orchestration: { enabled: true, orchestratorTabId: 'tab-o' } };
    workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
    workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('queues exactly one resume to the worker and nudges no one (the recorded W4 stop)', async () => {
    const { manager, nudges, resumes } = await setup();
    const entry = worker('claude-code', await transcript('claude-server-error-2.1.283.jsonl'));
    manager.registerTab('tab-w', entry);

    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(async () => expect(await resumes()).toHaveLength(1));
    await settle();

    const [resume] = await resumes();
    expect(resume).toMatchObject({ targetWorkspaceId: 'ws-1', targetTabId: 'tab-w', state: 'queued', dedupeKey: 'resume-tab-w-cbb7ecd3-be79-4c44-ac45-0fa53331e1c0' });
    expect(resume.line).toMatch(/^\[purplemux resume r-[A-Za-z0-9_-]{8}\] the last turn ended on an API error — continue from where it was cut off$/);
    expect(nudges()).toEqual([]);
    expect(entry.cliState).toBe('ready-for-review');
    expect(entry.turnError).toMatchObject({ class: 'api-error', code: 'server_error', resumeItemId: resume.id, escalated: false });
  });

  it('nudges api-error once, with the text, when the resumed turn fails again; no second resume', async () => {
    const { manager, nudges, resumes } = await setup();
    const file = await transcript('claude-server-error-2.1.283.jsonl');
    const entry = worker('claude-code', file);
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(async () => expect(entry.turnError?.resumeItemId).toBeTruthy());

    const second = await transcript('claude-server-error-2.1.283.jsonl', [
      { type: 'user', timestamp: '2026-09-26T01:31:00.000Z', message: { content: 'resume' } },
      { type: 'assistant', isApiErrorMessage: true, error: 'server_error', uuid: 'second-error', timestamp: '2026-09-26T01:32:00.000Z', message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: Server error mid-response. Again.' }] } },
      { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-09-26T01:32:01.000Z' },
    ]);
    await stopAgain(manager, entry, second);
    await waitFor(() => expect(nudges()).toHaveLength(1));
    await stopAgain(manager, entry, second);
    await settle();

    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toContain('API ERROR after its one automatic resume: API Error: Server error mid-response. Again.');
    expect(await resumes()).toHaveLength(1);
  });

  it('closes the episode on a clean marker stop and sends the normal turn-marker nudge', async () => {
    const { manager, nudges } = await setup();
    const entry = worker('claude-code', await transcript('claude-server-error-2.1.283.jsonl'));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(entry.turnError?.resumeItemId).toBeTruthy());

    await stopAgain(manager, entry, await transcript('claude-server-error-2.1.283.jsonl', [
      { type: 'user', timestamp: '2026-09-26T01:31:00.000Z', message: { content: 'resume' } },
      { type: 'assistant', timestamp: '2026-09-26T01:33:00.000Z', uuid: 'ok', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Gate green.\n\nDONE: resumed and finished' }] } },
    ]));
    await waitFor(() => expect(nudges()).toHaveLength(1));
    expect(nudges()[0]).toContain('ended: DONE: resumed and finished');
    expect(entry.turnError).toBeNull();
  });

  it('never types into a usage-limit halt; nudges usage-limit once per episode', async () => {
    const { manager, nudges, resumes } = await setup();
    const file = await transcript('codex-usage-limit-exceeded.jsonl');
    const entry = worker('codex-cli', file);
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(nudges()).toHaveLength(1));
    await stopAgain(manager, entry, file);
    await settle();

    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toContain('HALTED by a usage limit');
    expect(nudges()[0]).toContain('Do NOT type into it');
    expect(await resumes()).toEqual([]);
  });

  it('treats a Codex server_overloaded stop like the Claude API error: one resume, no nudge', async () => {
    const { manager, nudges, resumes } = await setup();
    const entry = worker('codex-cli', await transcript('codex-server-overloaded.jsonl'));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(async () => expect(await resumes()).toHaveLength(1));
    await settle();
    expect(nudges()).toEqual([]);
  });

  it.each([
    ['claude-authentication-failed.jsonl', 'claude-code'],
    ['codex-other-401.jsonl', 'codex-cli'],
    ['claude-usage-warning-footer-negative.jsonl', 'claude-code'],
  ] as Array<[string, TPanelType]>)('keeps story 15 behaviour for %s: READY nudge, no resume', async (fixture, panelType) => {
    const { manager, nudges, resumes } = await setup();
    const entry = worker(panelType, await transcript(fixture));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(nudges()).toHaveLength(1));
    expect(nudges()[0]).toContain('READY FOR REVIEW');
    expect(await resumes()).toEqual([]);
    expect(entry.turnError ?? null).toBeNull();
  });

  it('escalates once when the inbox holds the resume (e.g. a composer that keeps typed text)', async () => {
    const { manager, nudges, resumes, store } = await setup();
    const off = store.onInboxHeld((item) => manager.handleHeldResume(item));
    try {
      const entry = worker('claude-code', await transcript('claude-server-error-2.1.283.jsonl'));
      manager.registerTab('tab-w', entry);
      manager.updateTabFromHook('tmux-tab-w', 'stop');
      await waitFor(() => expect(entry.turnError?.resumeItemId).toBeTruthy());
      const [resume] = await resumes();
      await store.mutateInbox((s) => ({ state: store.holdInState(s, resume.id, 'composer-not-empty (30 refusals)', Date.now()), value: null }));
      await waitFor(() => expect(nudges()).toHaveLength(1));
      expect(nudges()[0]).toContain(`resume notice ${resume.id} held: composer-not-empty (30 refusals)`);
      manager.handleHeldResume({ ...resume, state: 'held' });
      await settle();
      expect(nudges()).toHaveLength(1);
    } finally {
      off();
    }
  });
});
