import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILayoutData, ITab } from '@/types/terminal';
import type { IAgentProvider } from '@/lib/providers/types';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/tmux', () => ({
  createSession: vi.fn(async () => {}),
  hasSession: vi.fn(async () => true),
  killSession: vi.fn(async () => {}),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sendKeys: vi.fn(async () => {}),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/providers/claude', () => ({ claudeProvider: {} }));

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-26T12:00:00Z');
const storeFile = () => path.join(mockHome.value, '.purplemux', 'session-tabs.json');
const stored = async () => JSON.parse(await fs.readFile(storeFile(), 'utf-8'));

const fakeProvider = (id: string): IAgentProvider => ({
  id,
  readSessionId: (tab: ITab) => (tab as ITab & { fakeSession?: string | null }).fakeSession ?? null,
  writeSessionId: (tab: ITab, sessionId: string | null | undefined) => { (tab as ITab & { fakeSession?: string | null }).fakeSession = sessionId ?? null; },
  readJsonlPath: () => null,
  writeJsonlPath: () => {},
  readSummary: () => null,
  writeSummary: () => {},
} as unknown as IAgentProvider);

describe('session-tabs store', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as { __ptSessionTabsSeen?: unknown }).__ptSessionTabsSeen;
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-session-tabs-'));
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('reads no binding before the first record', async () => {
    const { readSessionTabs } = await import('@/lib/spend/session-tabs-store');
    expect(await readSessionTabs()).toEqual({});
  });

  it('records a binding privately, keyed by provider and session', async () => {
    const { readSessionTabs, recordSessionTab } = await import('@/lib/spend/session-tabs-store');
    await recordSessionTab({ providerId: 'codex', sessionId: 'c-1', workspaceId: 'ws-a', tabId: 'tab-1' }, NOW);
    expect(await readSessionTabs()).toEqual({ 'codex:c-1': { workspaceId: 'ws-a', tabId: 'tab-1', firstSeenAt: NOW, lastSeenAt: NOW } });
    expect((await fs.stat(storeFile())).mode & 0o777).toBe(0o600);
    await expect(fs.access(`${storeFile()}.tmp`)).rejects.toThrow();
  });

  it('skips the write for a fresh known binding and touches it after an hour', async () => {
    const { recordSessionTab } = await import('@/lib/spend/session-tabs-store');
    await recordSessionTab({ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-1' }, NOW);
    const before = (await fs.stat(storeFile())).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await recordSessionTab({ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-1' }, NOW + 60_000);
    expect((await fs.stat(storeFile())).mtimeMs).toBe(before);
    await recordSessionTab({ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-1' }, NOW + 2 * 3_600_000);
    expect((await stored()).bindings['claude:s-1']).toMatchObject({ firstSeenAt: NOW, lastSeenAt: NOW + 2 * 3_600_000 });
  });

  it('moves a session to another tab only on a newer sighting', async () => {
    const { readSessionTabs, recordSessionTab, seedSessionTabs } = await import('@/lib/spend/session-tabs-store');
    await recordSessionTab({ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-1' }, NOW);
    expect(await seedSessionTabs([{ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-old', seenAt: NOW - DAY }], NOW)).toBe(0);
    await recordSessionTab({ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-2' }, NOW + 1);
    expect((await readSessionTabs())['claude:s-1']).toMatchObject({ tabId: 'tab-2', firstSeenAt: NOW + 1 });
  });

  it('seeds what it does not hold, and prunes bindings last seen before the spend floor', async () => {
    const { readSessionTabs, seedSessionTabs } = await import('@/lib/spend/session-tabs-store');
    expect(await seedSessionTabs([
      { providerId: 'grok', sessionId: 'g-1', workspaceId: 'ws-a', tabId: 'tab-g', seenAt: NOW - DAY },
      { providerId: 'claude', sessionId: 'edge', workspaceId: 'ws-a', tabId: 'tab-e', seenAt: NOW - 91 * DAY },
      { providerId: 'claude', sessionId: 'old', workspaceId: 'ws-a', tabId: 'tab-o', seenAt: NOW - 92 * DAY },
    ], NOW)).toBe(2);
    expect(Object.keys(await readSessionTabs()).sort()).toEqual(['claude:edge', 'grok:g-1']);
    await seedSessionTabs([], NOW + DAY);
    expect(Object.keys(await readSessionTabs())).toEqual(['grok:g-1']);
    await seedSessionTabs([], NOW + 90 * DAY);
    expect(Object.keys(await readSessionTabs())).toEqual(['grok:g-1']);
    await seedSessionTabs([], NOW + 91 * DAY);
    expect(await readSessionTabs()).toEqual({});
  });

  it.each([
    ['not JSON', '{"version":1', 'the file is not JSON'],
    ['a wrong shape', '{"version":2,"bindings":{}}', 'expected {version: 1'],
    ['a malformed binding', '{"version":1,"bindings":{"claude:x":{"workspaceId":"ws"}}}', 'binding claude:x is malformed'],
  ])('refuses %s instead of reading it as empty, and never overwrites it', async (_name, content, message) => {
    const { readSessionTabs, recordSessionTab, SessionTabsStoreError } = await import('@/lib/spend/session-tabs-store');
    await fs.mkdir(path.dirname(storeFile()), { recursive: true });
    await fs.writeFile(storeFile(), content);
    await expect(readSessionTabs()).rejects.toBeInstanceOf(SessionTabsStoreError);
    await expect(readSessionTabs()).rejects.toThrow(message);
    await expect(recordSessionTab({ providerId: 'claude', sessionId: 's', workspaceId: 'ws', tabId: 't' }, NOW)).rejects.toBeInstanceOf(SessionTabsStoreError);
    expect(await fs.readFile(storeFile(), 'utf-8')).toBe(content);
  });
});

describe('updateTabAgentSessionId records the binding', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as { __ptSessionTabsSeen?: unknown }).__ptSessionTabsSeen;
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-session-tabs-hook-'));
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const seedLayout = async () => {
    const store = await import('@/lib/layout-store');
    const layout: ILayoutData = {
      root: { type: 'pane', id: 'pane-one', activeTabId: 'tab-adopted',
        tabs: [{ id: 'tab-adopted', sessionName: 'pt-ws-a-pane-one-tab-orig', name: 'worker', order: 0, panelType: 'codex-cli' }] },
      activePaneId: 'pane-one',
      updatedAt: '2026-10-26T00:00:00.000Z',
    };
    await store.writeLayoutFile(layout, store.resolveLayoutFile('ws-a'));
    return store;
  };

  it('binds the session to the layout tab id, not the id in the session name', async () => {
    const store = await seedLayout();
    await store.updateTabAgentSessionId('pt-ws-a-pane-one-tab-orig', fakeProvider('codex'), 'c-9');
    expect((await stored()).bindings['codex:c-9']).toMatchObject({ workspaceId: 'ws-a', tabId: 'tab-adopted' });
  });

  it('records nothing for a cleared session or a tab no layout names', async () => {
    const store = await seedLayout();
    await store.updateTabAgentSessionId('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), null);
    await store.updateTabAgentSessionId('pt-ws-a-pane-one-tab-gone', fakeProvider('claude'), 's-1');
    await expect(fs.access(storeFile())).rejects.toThrow();
  });

  it('never fails the hook path when the binding store is damaged', async () => {
    const store = await seedLayout();
    await fs.writeFile(storeFile(), 'not json');
    await expect(store.updateTabAgentSessionId('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), 's-1')).resolves.toBeUndefined();
    const layout = await store.readLayoutFile(store.resolveLayoutFile('ws-a'));
    expect(layout?.root.type === 'pane' && (layout.root.tabs[0] as ITab & { fakeSession?: string }).fakeSession).toBe('s-1');
    expect(await fs.readFile(storeFile(), 'utf-8')).toBe('not json');
  });
});

describe('updateTabAgentState records the binding (the status manager hook, launch and poll writer)', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as { __ptSessionTabsSeen?: unknown }).__ptSessionTabsSeen;
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-session-tabs-state-'));
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const seedLayout = async () => {
    const store = await import('@/lib/layout-store');
    const layout: ILayoutData = {
      root: { type: 'pane', id: 'pane-one', activeTabId: 'tab-adopted',
        tabs: [{ id: 'tab-adopted', sessionName: 'pt-ws-a-pane-one-tab-orig', name: 'worker', order: 0, panelType: 'codex-cli' }] },
      activePaneId: 'pane-one',
      updatedAt: '2026-10-26T00:00:00.000Z',
    };
    await store.writeLayoutFile(layout, store.resolveLayoutFile('ws-a'));
    return store;
  };

  it('binds a saved session id to the layout tab id', async () => {
    const store = await seedLayout();
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('codex'), { sessionId: 'c-hook', jsonlPath: null });
    expect((await stored()).bindings['codex:c-hook']).toMatchObject({ workspaceId: 'ws-a', tabId: 'tab-adopted' });
  });

  it('records nothing for a reset session, a save without a session id, or a tab no layout names', async () => {
    const store = await seedLayout();
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { sessionId: null, jsonlPath: null });
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { summary: 'a summary' });
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-gone', fakeProvider('claude'), { sessionId: 's-1' });
    await expect(fs.access(storeFile())).rejects.toThrow();
  });

  it('binds each new session of a cleared tab to the same tab id', async () => {
    const store = await seedLayout();
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { sessionId: 's-old' });
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { sessionId: null });
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { sessionId: 's-new' });
    const { bindings } = await stored();
    expect(bindings['claude:s-old']).toMatchObject({ workspaceId: 'ws-a', tabId: 'tab-adopted' });
    expect(bindings['claude:s-new']).toMatchObject({ workspaceId: 'ws-a', tabId: 'tab-adopted' });
  });

  it('never fails the hook save when the binding store is damaged', async () => {
    const store = await seedLayout();
    await fs.mkdir(path.dirname(storeFile()), { recursive: true });
    await fs.writeFile(storeFile(), 'not json');
    await expect(store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { sessionId: 's-1' })).resolves.toBeUndefined();
    const layout = await store.readLayoutFile(store.resolveLayoutFile('ws-a'));
    expect(layout?.root.type === 'pane' && (layout.root.tabs[0] as ITab & { fakeSession?: string }).fakeSession).toBe('s-1');
    expect(await fs.readFile(storeFile(), 'utf-8')).toBe('not json');
  });
});
