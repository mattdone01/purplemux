import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ITab, TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';

// ADR-0050: `tab send` to a busy Claude tab queues an inbox `message` (200 queued, exit 0);
// every refusal of today stays, and creates no item.

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

const panes = vi.hoisted(() => {
  const rule = '─'.repeat(60);
  const claude = (composer: string): string => ['● Earlier output', '', rule, `❯ ${composer}`, rule, '  ⏵⏵ bypass permissions on'].join('\n');
  return { claude, empty: claude('') };
});

const tmux = vi.hoisted(() => ({
  hasSession: vi.fn(async () => true),
  isContentPendingInComposer: vi.fn(async () => false),
  capturePaneContent: vi.fn(async (_session: string, _opts?: unknown): Promise<string | null> => panes.empty),
  isPaneShowingPendingLine: (pane: string, content: string): boolean => pane.includes(`❯ ${content.split('\n')[0]}`),
  pressEnter: vi.fn(async (_session: string) => {}),
}));
const delivery = vi.hoisted(() => ({ deliverPrompt: vi.fn(async (_session: string, _content: string) => {}) }));
const cliUtils = vi.hoisted(() => ({
  findTab: vi.fn(),
  authorizeWorkspaceInput: vi.fn(async (): Promise<{ type: string; workspaceId: string; tabId?: string } | null> => ({ type: 'workspace', workspaceId: 'ws-A' })),
}));
const caller = vi.hoisted(() => ({
  value: { workspaceId: 'ws-A', tabId: 'tab-2' as string | null, admin: false } as { workspaceId: string; tabId: string | null; admin: boolean },
}));
const live = vi.hoisted(() => ({
  entries: {} as Record<string, { cliState: TCliState; startupPrompt?: { kind: 'folder-trust'; since: number } | null }>,
  waiting: new Set<string>(),
  evidence: {} as Record<string, import('@/types/status').ISubmitEvidence>,
}));
const fleet = vi.hoisted(() => ({ values: {} as Record<string, string>, unreadable: false }));
const dispatchPolicy = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/ledger-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ledger-store')>();
  const store = new actual.LedgerStore(':memory:');
  return { ...actual, getLedgerStore: () => store };
});
vi.mock('@/lib/agent-dispatch-policy', () => ({
  withAgentDispatchLock: async (_ws: string, _t: ITab, work: (c: () => Promise<unknown>) => Promise<unknown>) => work(dispatchPolicy),
  withAgentDispatchThen: async (_ws: string, _t: ITab, work: (c: () => Promise<unknown>) => Promise<unknown>, after: (typed: unknown) => Promise<unknown>) =>
    after(await work(dispatchPolicy)),
}));
vi.mock('@/lib/fleet-config-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fleet-config-store')>();
  return {
    ...actual,
    readFleetConfig: async () => {
      if (fleet.unreadable) throw new actual.FleetConfigFileError('fleet-config.json is unreadable');
      return {
      values: Object.fromEntries(Object.entries(fleet.values).map(([k, value]) => [k, { value, version: 1, setBy: { tabId: null, workspaceId: null, admin: true } }])),
      versions: {}, history: [],
      };
    },
  };
});
vi.mock('@/lib/tmux', () => Object.assign(tmux, { hasSessionOrUnreachable: tmux.hasSession }));
vi.mock('@/lib/agent-prompt-delivery', () => delivery);
vi.mock('@/lib/cli-utils', () => cliUtils);
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({
    getAllForClient: () => live.entries,
    isWaitingAtPrompt: (id: string) => live.waiting.has(id),
    getSubmitEvidence: (id: string) => live.evidence[id] ?? null,
    routeTabEvent: vi.fn(),
  }),
}));

const WS = 'ws-A';
const TAB = 'tab-1';
const SESSION = 'pt-ws-A-pane-a-tab-1';

const tabWith = (cliState: TCliState | undefined, panelType: TPanelType = 'claude-code'): ITab =>
  ({ id: TAB, sessionName: SESSION, name: 'worker', order: 0, panelType, cliState });
const locate = (tab: ITab) => ({ workspaceId: WS, paneId: 'pane-1', tab });

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
    end() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

type THandler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

describe('POST /api/cli/tabs/[tabId]/send: the busy-tab queue (ADR-0050)', () => {
  let handler: THandler;
  let store: typeof import('@/lib/inbox-store');

  const call = async (body: Record<string, unknown>) => {
    const { state, res } = fakeResponse();
    await handler({ method: 'POST', query: { tabId: TAB, workspaceId: WS }, body } as unknown as NextApiRequest, res);
    return state;
  };
  const items = async () => (await store.readInboxState()).items;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-send-queue-'));
    live.entries = { [TAB]: { cliState: 'busy' } };
    live.waiting = new Set();
    live.evidence = { [TAB]: { cliState: 'idle', eventSeq: 4, lastPromptSubmitSeq: 2, lastEventFromTool: false } };
    fleet.values = {};
    fleet.unreadable = false;
    caller.value = { workspaceId: WS, tabId: 'tab-2', admin: false };
    dispatchPolicy.mockResolvedValue({ ok: true });
    tmux.hasSession.mockResolvedValue(true);
    tmux.capturePaneContent.mockResolvedValue(panes.empty);
    cliUtils.authorizeWorkspaceInput.mockImplementation(async () => ({
      type: 'workspace', workspaceId: caller.value.workspaceId, ...(caller.value.tabId ? { tabId: caller.value.tabId } : {}),
    }));
    cliUtils.findTab.mockResolvedValue(locate(tabWith('busy')));
    delivery.deliverPrompt.mockImplementation(async () => {
      const before = live.evidence[TAB];
      live.evidence[TAB] = { ...before, cliState: 'busy', eventSeq: before.eventSeq + 1, lastPromptSubmitSeq: before.eventSeq + 1 };
    });
    store = await import('@/lib/inbox-store');
    ({ default: handler } = await import('@/pages/api/cli/tabs/[tabId]/send'));
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('send-busy-claude-queues: a busy Claude tab answers 200 queued with a message id at once, and nothing is typed', async () => {
    const started = Date.now();
    const response = await call({ content: 'please rebase onto main' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: 'queued', submitted: false, messageId: expect.stringMatching(/^i-/), delivery: 'queued' });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
    const [item] = await items();
    expect(item).toMatchObject({
      id: (response.body as { messageId: string }).messageId, kind: 'message', state: 'queued', targetWorkspaceId: WS, targetTabId: TAB,
      message: { fromWorkspaceId: WS, fromTabId: 'tab-2', body: 'please rebase onto main', targetSessionName: SESSION, claimedAt: null },
    });
  });

  it('send-not-ready-by-deadline-queues: a tab not ready by waitMs is queued, not refused 409', async () => {
    live.entries = { [TAB]: { cliState: 'inactive' } };
    cliUtils.findTab.mockResolvedValue(locate(tabWith('inactive')));
    const response = await call({ content: 'hello', waitMs: 20 });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ status: 'queued', delivery: 'queued' });
    expect(await items()).toHaveLength(1);
  });

  it('a ready tab whose composer holds text is queued at its deadline', async () => {
    live.entries = { [TAB]: { cliState: 'idle' } };
    cliUtils.findTab.mockResolvedValue(locate(tabWith('idle')));
    tmux.capturePaneContent.mockResolvedValue(panes.claude('a draft'));
    const response = await call({ content: 'hello', waitMs: 0 });
    expect(response.body).toMatchObject({ status: 'queued' });
  });

  it('an idle tab with an empty queue keeps today\'s path, and the answer adds delivery: delivered', async () => {
    live.entries = { [TAB]: { cliState: 'idle' } };
    cliUtils.findTab.mockResolvedValue(locate(tabWith('idle')));
    const response = await call({ content: 'run the tests' });
    expect(response.body).toEqual({ status: 'sent', submitted: true, cliState: 'idle', confirmation: 'prompt-submit', resubmitted: false, delivery: 'delivered' });
    expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION, 'run the tests');
    expect(await items()).toEqual([]);
  });

  it('a typed send with no proven turn answers delivery: held with notSubmitted', async () => {
    live.entries = { [TAB]: { cliState: 'idle' } };
    cliUtils.findTab.mockResolvedValue(locate(tabWith('idle')));
    delivery.deliverPrompt.mockImplementation(async () => {});
    tmux.capturePaneContent.mockResolvedValueOnce(panes.empty).mockResolvedValue(panes.claude('run the tests'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    let response: Awaited<ReturnType<typeof call>>;
    try {
      let settled = false;
      const pending = call({ content: 'run the tests' }).finally(() => { settled = true; });
      while (!settled) await vi.advanceTimersByTimeAsync(250);
      response = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(response.body).toMatchObject({ status: 'sent', submitted: false, delivery: 'held', notSubmitted: 'typed-not-submitted' });
  });

  it('message-fifo-per-target: an idle tab with a queued message queues the next send behind it, typing nothing', async () => {
    await call({ content: 'first' });
    live.entries = { [TAB]: { cliState: 'idle' } };
    cliUtils.findTab.mockResolvedValue(locate(tabWith('idle')));
    const response = await call({ content: 'second' });
    expect(response.body).toMatchObject({ status: 'queued' });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
    expect((await items()).map((i) => i.message?.body)).toEqual(['first', 'second']);
  });

  it('message-claim-once: a direct send and two dispatcher ticks race one queued item; it is typed exactly once', async () => {
    await call({ content: 'first' });
    live.entries = { [TAB]: { cliState: 'idle' } };
    cliUtils.findTab.mockResolvedValue(locate(tabWith('idle')));
    const { InboxDispatcher } = await import('@/lib/inbox-dispatcher');
    const deps = {
      now: () => Date.now(), mutate: store.mutateInbox, findTab: async () => tabWith('idle'), tabGone: async () => false,
      hasSession: async () => true, status: () => ({ cliState: 'idle', permissionRequest: null }) as never, waitingAtPrompt: () => false,
      halted: () => false, capture: async () => panes.empty, withDispatchLock: async (_w: string, _t: ITab, work: (c: () => Promise<never>) => Promise<unknown>) => work(async () => ({ ok: true }) as never),
      deliver: delivery.deliverPrompt, isPending: async () => false, pressEnter: async () => {}, messageQueueEnabled: async () => true,
    };
    const [a, b] = [new InboxDispatcher(deps as never), new InboxDispatcher(deps as never)];
    const [sent] = await Promise.all([call({ content: 'second' }), a.tick(), b.tick()]);
    const typedFirst = delivery.deliverPrompt.mock.calls.filter(([, text]) => String(text).endsWith('\nfirst'));
    expect(typedFirst).toHaveLength(1);
    expect(delivery.deliverPrompt.mock.calls.filter(([, text]) => text === 'second')).toHaveLength(0);
    expect(sent.body).toMatchObject({ status: 'queued' });
  });

  it('send-startup-prompt-exit5-unchanged: a startup prompt refuses 409 startup-prompt at once and creates no item', async () => {
    live.entries = { [TAB]: { cliState: 'startup-prompt', startupPrompt: { kind: 'folder-trust', since: 1 } } };
    const response = await call({ content: 'brief' });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: 'startup-prompt' });
    expect(await items()).toEqual([]);
  });

  it('send-gone-and-dead-exit4-no-item: tab-not-found and session-not-running answer as today and create no item', async () => {
    cliUtils.findTab.mockResolvedValue(null);
    const gone = await call({ content: 'brief' });
    expect(gone.statusCode).toBe(404);
    expect(gone.body).toMatchObject({ code: 'tab-not-found' });
    cliUtils.findTab.mockResolvedValue(locate(tabWith('busy')));
    tmux.hasSession.mockResolvedValue(false);
    const dead = await call({ content: 'brief' });
    expect(dead.statusCode).toBe(409);
    expect(dead.body).toMatchObject({ code: 'session-not-running' });
    expect(await items()).toEqual([]);
  });

  it('send-other-workspace-refused-no-item: a drive-guard refusal creates no item', async () => {
    cliUtils.authorizeWorkspaceInput.mockResolvedValue(null);
    await call({ content: 'brief' });
    expect(cliUtils.findTab).not.toHaveBeenCalled();
    expect(await items()).toEqual([]);
  });

  it('a sender of another workspace admitted by the drive guard (the selected Scrum Master) keeps today\'s refusal: no body crosses a wall', async () => {
    caller.value = { workspaceId: 'ws-SM', tabId: 'tab-sm', admin: false };
    const response = await call({ content: 'brief', waitMs: 0 });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: 'readiness-timeout' });
    expect(await items()).toEqual([]);
  });

  it.each<TPanelType>(['codex-cli', 'grok-cli'])('send-codex-grok-terminal-unchanged: a busy %s tab still refuses readiness-timeout', async (panelType) => {
    cliUtils.findTab.mockResolvedValue(locate(tabWith('busy', panelType)));
    const response = await call({ content: 'brief', waitMs: 0 });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: 'readiness-timeout' });
    expect(await items()).toEqual([]);
  });

  it('send-codex-grok-terminal-unchanged: a terminal tab is typed at once', async () => {
    cliUtils.findTab.mockResolvedValue(locate(tabWith(undefined, 'terminal')));
    const response = await call({ content: 'ls' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ status: 'sent' });
    expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION, 'ls');
    expect(await items()).toEqual([]);
  });

  it('send-no-queue-and-switch-off-exit5: noQueue gives today\'s readiness-timeout for one call', async () => {
    const response = await call({ content: 'brief', waitMs: 0, noQueue: true });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: 'readiness-timeout' });
    expect(await items()).toEqual([]);
  });

  it('send-no-queue-and-switch-off-exit5: tab-send.queue off gives today\'s readiness-timeout for every call', async () => {
    fleet.values = { 'tab-send.queue': 'off' };
    const response = await call({ content: 'brief', waitMs: 0 });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: 'readiness-timeout' });
    expect(await items()).toEqual([]);
  });

  it('message-queue-cap: the 21st queued send answers 409 message-queue-full', async () => {
    for (let n = 0; n < 20; n++) expect((await call({ content: `m${n}` })).statusCode).toBe(200);
    const response = await call({ content: 'one too many' });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: 'message-queue-full', tabId: TAB });
    expect(await items()).toHaveLength(20);
  });

  it('supersedes an older queued message of the same sender and key', async () => {
    const first = await call({ content: 'taken by me', supersede: 'pr-12.taken' });
    const second = await call({ content: 'released', supersede: 'pr-12.taken' });
    const all = await items();
    expect(all.find((i) => i.id === (first.body as { messageId: string }).messageId))
      .toMatchObject({ state: 'dropped', droppedReason: `superseded-by:${(second.body as { messageId: string }).messageId}` });
  });

  it('supersede-needs-sender: a send with a key and no resolved sender tab answers 400 invalid-request and creates nothing', async () => {
    caller.value = { workspaceId: WS, tabId: null, admin: false };
    const response = await call({ content: 'brief', supersede: 'k' });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'invalid-request' });
    expect(await items()).toEqual([]);
  });

  it.each([
    ['a key with a space', { supersede: 'a b' }],
    ['a key over 64 characters', { supersede: 'k'.repeat(65) }],
    ['a TTL of 0', { ttlMin: 0 }],
    ['a TTL over 1440', { ttlMin: 1441 }],
    ['a TTL that is not whole', { ttlMin: 1.5 }],
    ['a noQueue that is not boolean', { noQueue: 'yes' }],
  ])('400s %s', async (_label, extra) => {
    const response = await call({ content: 'brief', ...extra });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'invalid-request' });
  });

  it('takes ttlMin as the queued item\'s expiry', async () => {
    const before = Date.now();
    await call({ content: 'brief', ttlMin: 5 });
    const [item] = await items();
    expect(item.expiresAt - before).toBeGreaterThanOrEqual(5 * 60_000);
    expect(item.expiresAt - before).toBeLessThan(5 * 60_000 + 5_000);
  });

  describe('today\'s refusals with the switch on and a message already queued (review B1, N6)', () => {
    const queueOne = async () => {
      expect((await call({ content: 'first' })).body).toMatchObject({ status: 'queued' });
      expect(await items()).toHaveLength(1);
    };

    it('a startup prompt answers 409 startup-prompt at once and creates no item, although a message waits', async () => {
      await queueOne();
      live.entries = { [TAB]: { cliState: 'startup-prompt', startupPrompt: { kind: 'folder-trust', since: 1 } } };
      const response = await call({ content: 'brief' });
      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({ code: 'startup-prompt', startupPrompt: 'folder-trust' });
      expect(await items()).toHaveLength(1);
    });

    it('session-not-running and tab-not-found answer as today and create no item, although a message waits', async () => {
      await queueOne();
      tmux.hasSession.mockResolvedValue(false);
      expect((await call({ content: 'brief' })).body).toMatchObject({ code: 'session-not-running' });
      tmux.hasSession.mockResolvedValue(true);
      cliUtils.findTab.mockResolvedValue(null);
      expect((await call({ content: 'brief' })).statusCode).toBe(404);
      expect(await items()).toHaveLength(1);
    });

    it('a tab replaced inside the dispatch lock answers 409 target-changed and creates no item', async () => {
      live.entries = { [TAB]: { cliState: 'idle' } };
      cliUtils.findTab
        .mockResolvedValueOnce(locate(tabWith('idle')))
        .mockResolvedValueOnce(locate(tabWith('idle')))
        .mockResolvedValue(null);
      const response = await call({ content: 'hello' });
      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({ code: 'target-changed' });
      expect(await items()).toEqual([]);
      expect(delivery.deliverPrompt).not.toHaveBeenCalled();
    });
  });

  it('a config store the route cannot read keeps today\'s path: the route fails closed (review N7)', async () => {
    fleet.unreadable = true;
    const response = await call({ content: 'brief', waitMs: 0 });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: 'readiness-timeout' });
    expect(await items()).toEqual([]);
  });
});
