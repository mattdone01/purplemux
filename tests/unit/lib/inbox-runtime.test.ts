import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ getAllForClient: () => ({}), isWaitingAtPrompt: () => false }),
}));

describe('inbox runtime wiring', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-inbox-rt-'));
  });
  afterEach(async () => {
    (await import('@/lib/inbox-dispatcher')).stopInbox();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('drops a closed tab\'s notices on its tab-closed event, and stops listening after stopInbox', async () => {
    const store = await import('@/lib/inbox-store');
    const { startInbox, stopInbox } = await import('@/lib/inbox-dispatcher');
    const { emitTabClosed } = await import('@/lib/tab-lifecycle');
    await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-a', dedupeKey: 'a', fields: { resumeId: 'r-aaaa11' } });
    await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-b', dedupeKey: 'b', fields: { resumeId: 'r-bbbb22' } });

    await startInbox();
    emitTabClosed({ workspaceId: 'ws-1', tabId: 'tab-a', sessionName: 's-a', reason: 'layout-removed' });
    await vi.waitFor(async () => {
      const states = Object.fromEntries((await store.readInboxState()).items.map((i) => [i.targetTabId, i.state]));
      expect(states).toEqual({ 'tab-a': 'dropped', 'tab-b': 'queued' });
    });

    stopInbox();
    emitTabClosed({ workspaceId: 'ws-1', tabId: 'tab-b', sessionName: 's-b', reason: 'layout-removed' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await store.readInboxState()).items.find((i) => i.targetTabId === 'tab-b')?.state).toBe('queued');
  });
});
