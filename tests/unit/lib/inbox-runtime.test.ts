import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '' }));
const warnings = vi.hoisted(() => [] as string[]);
// The file logger writes under the temp HOME, which each test removes; a write
// still pending at removal surfaced as an unhandled ENOENT (gate 26-r1).
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: (message: unknown) => { warnings.push(String(message)); }, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ getAllForClient: () => ({}), isWaitingAtPrompt: () => false, isHaltedByUsageLimit: () => false }),
}));

const base = () => path.join(mockHome.value, '.purplemux');

/** workspaces.json + one layout naming `tabs`. */
const writeLayout = async (tabs: string[]) => {
  await fs.mkdir(path.join(base(), 'workspaces', 'ws-1'), { recursive: true });
  await fs.writeFile(path.join(base(), 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'ws-1', name: 'w', directories: ['/tmp'] }] }));
  await fs.writeFile(path.join(base(), 'workspaces', 'ws-1', 'layout.json'), JSON.stringify({
    root: { type: 'pane', id: 'pane-1', activeTabId: tabs[0], tabs: tabs.map((id, order) => ({ id, sessionName: `s-${id}`, name: id, order })) },
    activePaneId: 'pane-1',
    updatedAt: '2026-09-26T00:00:00.000Z',
  }));
};

const seed = async () => {
  const store = await import('@/lib/inbox-store');
  const a = await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-a', dedupeKey: 'a', fields: { resumeId: 'r-aaaa11' } });
  await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-b', dedupeKey: 'b', fields: { resumeId: 'r-bbbb22' } });
  await store.mutateInbox((s) => ({ state: store.holdInState(s, a.item.id, 'composer-not-empty (30 refusals)', Date.now()), value: null }));
  return store;
};

const states = async (store: Awaited<ReturnType<typeof seed>>) =>
  Object.fromEntries((await store.readInboxState()).items.map((i) => [i.targetTabId, i.state]));

describe('inbox runtime wiring', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-inbox-rt-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    warnings.length = 0;
    await (await import('@/lib/inbox-dispatcher')).stopInbox();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('boot pass: a held notice for a tab that closed while the server was down (its event fired before start) is dropped', async () => {
    const store = await seed();
    await writeLayout(['tab-b']);
    const { emitTabClosed } = await import('@/lib/tab-lifecycle');
    emitTabClosed({ workspaceId: 'ws-1', tabId: 'tab-a', sessionName: 's-tab-a', reason: 'boot-sweep' });
    expect(await states(store)).toEqual({ 'tab-a': 'held', 'tab-b': 'queued' });

    await (await import('@/lib/inbox-dispatcher')).startInbox();
    expect(await states(store)).toEqual({ 'tab-a': 'dropped', 'tab-b': 'queued' });
  });

  it('boot pass drops nothing when the workspace list is unreadable', async () => {
    const store = await seed();
    await fs.mkdir(base(), { recursive: true });
    await fs.writeFile(path.join(base(), 'workspaces.json'), '{ not json');
    await (await import('@/lib/inbox-dispatcher')).startInbox();
    expect(await states(store)).toEqual({ 'tab-a': 'held', 'tab-b': 'queued' });
  });

  it('drops a closed tab\'s notices on its tab-closed event, and stops listening after stopInbox', async () => {
    const store = await seed();
    await writeLayout(['tab-a', 'tab-b']);
    const { startInbox, stopInbox } = await import('@/lib/inbox-dispatcher');
    const { emitTabClosed } = await import('@/lib/tab-lifecycle');
    await startInbox();
    expect(await states(store)).toEqual({ 'tab-a': 'held', 'tab-b': 'queued' });

    emitTabClosed({ workspaceId: 'ws-1', tabId: 'tab-a', sessionName: 's-tab-a', reason: 'layout-removed' });
    await vi.waitFor(async () => expect(await states(store)).toEqual({ 'tab-a': 'dropped', 'tab-b': 'queued' }));

    await stopInbox();
    emitTabClosed({ workspaceId: 'ws-1', tabId: 'tab-b', sessionName: 's-tab-b', reason: 'layout-removed' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await states(store))['tab-b']).toBe('queued');
  });

  it('starts once under concurrent starts: one tab-closed listener, one timer', async () => {
    await writeLayout(['tab-a']);
    const { startInbox } = await import('@/lib/inbox-dispatcher');
    await import('@/lib/tab-lifecycle');
    const lifecycle = (globalThis as unknown as { __ptTabLifecycle: { listeners: Set<unknown> } }).__ptTabLifecycle;
    const before = lifecycle.listeners.size;
    await Promise.all([startInbox(), startInbox(), startInbox()]);
    expect(lifecycle.listeners.size).toBe(before + 1);
  });

  it('refuses, never drops, a notice whose layout is unreadable, and never rewrites that layout', async () => {
    const store = await seed();
    await writeLayout(['tab-a', 'tab-b']);
    const layoutFile = path.join(base(), 'workspaces', 'ws-1', 'layout.json');
    const { startInbox } = await import('@/lib/inbox-dispatcher');
    await startInbox();
    await fs.writeFile(layoutFile, '{ corrupt');
    const runtime = (globalThis as unknown as { __ptInboxRuntime: { dispatcher: { tick: () => Promise<void> } } }).__ptInboxRuntime;
    await runtime.dispatcher.tick();
    const b = (await store.readInboxState()).items.find((item) => item.targetTabId === 'tab-b');
    expect(b).toMatchObject({ state: 'queued', lastRefusal: 'target-unresolved' });
    expect(await fs.readFile(layoutFile, 'utf-8')).toBe('{ corrupt');
  });

  describe('the first tick waits for the boot drain of the hook spool (ADR-0020)', () => {
    type TRuntime = { __ptInboxRuntime: { dispatcher: { tick: () => Promise<void> } } };
    const startGated = async (gate: Promise<unknown>) => {
      await writeLayout(['tab-a']);
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
      const inbox = await import('@/lib/inbox-dispatcher');
      await inbox.startInbox({ firstTickAfter: gate });
      const tick = vi.spyOn((globalThis as unknown as TRuntime).__ptInboxRuntime.dispatcher, 'tick').mockResolvedValue();
      return { inbox, tick };
    };

    it('skips every tick until the drain settles, then ticks', async () => {
      let drained!: () => void;
      const { inbox, tick } = await startGated(new Promise<void>((resolve) => { drained = resolve; }));
      await vi.advanceTimersByTimeAsync(inbox.INBOX_TICK_MS * 4);
      expect(tick).not.toHaveBeenCalled();

      drained();
      await vi.advanceTimersByTimeAsync(inbox.INBOX_TICK_MS);
      expect(tick).toHaveBeenCalledTimes(1);
      expect(warnings).toEqual([]);
    });

    it('starts anyway after 10 s and says so, when the drain has not finished', async () => {
      const { inbox, tick } = await startGated(new Promise<void>(() => {}));
      expect(inbox.INBOX_FIRST_TICK_MAX_WAIT_MS).toBe(10_000);
      await vi.advanceTimersByTimeAsync(inbox.INBOX_FIRST_TICK_MAX_WAIT_MS - 1);
      expect(tick).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(inbox.INBOX_TICK_MS);
      expect(tick).toHaveBeenCalledTimes(1);
      expect(warnings).toEqual(['inbox: the first boot drain of the hook spool took over 10000 ms; the inbox starts anyway']);
    });

    it('a drain that fails still opens the gate; without a gate the inbox ticks at once', async () => {
      const failed = Promise.reject(new Error('drain failed'));
      failed.catch(() => {}); // handled here; the gate still sees the rejection
      const { inbox, tick } = await startGated(failed);
      await vi.advanceTimersByTimeAsync(inbox.INBOX_TICK_MS);
      expect(tick).toHaveBeenCalledTimes(1);
      await inbox.stopInbox();

      await inbox.startInbox();
      const ungated = vi.spyOn((globalThis as unknown as TRuntime).__ptInboxRuntime.dispatcher, 'tick').mockResolvedValue();
      await vi.advanceTimersByTimeAsync(inbox.INBOX_TICK_MS);
      expect(ungated).toHaveBeenCalledTimes(1);
      expect(warnings).toEqual([]);
    });
  });

  it('installs nothing when stopped while starting', async () => {
    await writeLayout(['tab-a']);
    const { startInbox, stopInbox } = await import('@/lib/inbox-dispatcher');
    await import('@/lib/tab-lifecycle');
    const lifecycle = (globalThis as unknown as { __ptTabLifecycle: { listeners: Set<unknown> } }).__ptTabLifecycle;
    const before = lifecycle.listeners.size;
    const starting = startInbox();
    await stopInbox();
    await starting;
    expect(lifecycle.listeners.size).toBe(before);
    expect((globalThis as unknown as { __ptInboxRuntime?: unknown }).__ptInboxRuntime).toBeUndefined();
  });
});
