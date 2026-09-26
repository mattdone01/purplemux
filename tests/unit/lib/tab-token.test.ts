import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILiveTab } from '@/lib/tab-lifecycle';
import type { TTabTokens } from '@/lib/tab-token';

const mockHome = vi.hoisted(() => ({ value: '' }));
const logs = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: (msg: string) => logs.info.push(msg),
    warn: (msg: string) => logs.warn.push(msg),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const resetGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  delete g.__ptTabTokens;
  delete g.__ptTabTokenLock;
  delete g.__ptTabTokenRevokeInstalled;
  delete g.__ptTabLifecycle;
};

const tokensPath = () => path.join(mockHome.value, '.purplemux', 'tab-tokens.json');

const record = (workspaceId: string, sessionName: string, token = 'a'.repeat(64)) => ({
  token,
  workspaceId,
  sessionName,
  createdAt: '2026-09-26T00:00:00.000Z',
});

describe('tab token store', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetGlobals();
    logs.info = [];
    logs.warn = [];
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-tab-token-'));
  });

  afterEach(async () => {
    await (globalThis as { __ptTabTokenLock?: Promise<void> }).__ptTabTokenLock;
    resetGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('mints a 32-byte hex token per tab and persists it with mode 0600', async () => {
    const { ensureTabToken } = await import('@/lib/tab-token');
    const token = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 'pt-ws-a-pane-1-tab-1');

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const stat = await fs.stat(tokensPath());
    expect(stat.mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(await fs.readFile(tokensPath(), 'utf-8'));
    expect(onDisk['tab-1']).toMatchObject({ token, workspaceId: 'ws-a', sessionName: 'pt-ws-a-pane-1-tab-1' });
    expect(Number.isNaN(Date.parse(onDisk['tab-1'].createdAt))).toBe(false);
  });

  it('gives every tab its own token', async () => {
    const { ensureTabToken } = await import('@/lib/tab-token');
    const a = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 's1');
    const b = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-2' }, 's2');
    expect(a).not.toBe(b);
  });

  it('reuses the token when a session is recreated for an existing tab', async () => {
    const { ensureTabToken } = await import('@/lib/tab-token');
    const first = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 'pt-ws-a-pane-1-tab-1');
    const again = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 'pt-ws-a-pane-1-tab-1');
    expect(again).toBe(first);
  });

  it('keeps the token and records the new session name when the session is renamed', async () => {
    const { ensureTabToken, getTabTokenRecord } = await import('@/lib/tab-token');
    const first = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 'old-session');
    const again = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 'new-session');
    expect(again).toBe(first);
    expect(getTabTokenRecord('tab-1')?.sessionName).toBe('new-session');
  });

  it('survives a restart: a fresh module graph reads the file', async () => {
    const first = await import('@/lib/tab-token');
    const token = await first.ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 's1');

    vi.resetModules();
    resetGlobals();
    const second = await import('@/lib/tab-token');
    expect(second.resolveTabToken(token)?.tabId).toBe('tab-1');
  });

  it('resolves only an exact token', async () => {
    const { ensureTabToken, resolveTabToken } = await import('@/lib/tab-token');
    const token = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 's1');

    expect(resolveTabToken(token)).toMatchObject({ tabId: 'tab-1', record: { workspaceId: 'ws-a' } });
    expect(resolveTabToken(token.slice(0, -1))).toBeNull();
    expect(resolveTabToken(`${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`)).toBeNull();
    expect(resolveTabToken('')).toBeNull();
    expect(resolveTabToken(undefined)).toBeNull();
  });

  it('stops resolving a revoked token and persists the revocation', async () => {
    const { ensureTabToken, resolveTabToken, revokeTabToken } = await import('@/lib/tab-token');
    const token = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 's1');

    expect(await revokeTabToken('tab-1')).toBe(true);
    expect(resolveTabToken(token)).toBeNull();
    expect(JSON.parse(await fs.readFile(tokensPath(), 'utf-8'))).toEqual({});
    expect(await revokeTabToken('tab-1')).toBe(false);
  });

  it('starts empty on a corrupt file, moves it aside instead of overwriting it, and says so', async () => {
    await fs.mkdir(path.dirname(tokensPath()), { recursive: true });
    await fs.writeFile(tokensPath(), '{not json');
    const { ensureTabToken, resolveTabToken, getTabTokenRecord } = await import('@/lib/tab-token');

    expect(resolveTabToken('a'.repeat(64))).toBeNull();
    expect(getTabTokenRecord('tab-1')).toBeNull();
    expect(logs.warn.some((m) => m.includes('tab-tokens.json unreadable, moved to'))).toBe(true);

    await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-2' }, 's2');
    const aside = (await fs.readdir(path.dirname(tokensPath()))).filter((f) => f.startsWith('tab-tokens.json.unreadable-'));
    expect(aside).toHaveLength(1);
    expect(await fs.readFile(path.join(path.dirname(tokensPath()), aside[0]), 'utf-8')).toBe('{not json');
  });

  it('does not move a file aside for an I/O error that is not bad JSON', async () => {
    await fs.mkdir(tokensPath(), { recursive: true });
    const { resolveTabToken } = await import('@/lib/tab-token');

    expect(resolveTabToken('a'.repeat(64))).toBeNull();
    expect(logs.warn.some((m) => m.includes('could not be read, serving empty this run'))).toBe(true);
    expect((await fs.stat(tokensPath())).isDirectory()).toBe(true);
    expect((await fs.readdir(path.dirname(tokensPath()))).some((f) => f.includes('.unreadable-'))).toBe(false);
  });

  it('withdraws a new token that cannot be saved and throws', async () => {
    await fs.mkdir(`${tokensPath()}.tmp`, { recursive: true });
    const { ensureTabToken, getTabTokenRecord } = await import('@/lib/tab-token');

    await expect(ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 's1')).rejects.toThrow('could not be saved');
    expect(getTabTokenRecord('tab-1')).toBeNull();
    expect(logs.warn.some((m) => m.includes('tab-tokens.json write failed'))).toBe(true);
  });

  it('finds the tab id a token was minted for by exact workspace and session name', async () => {
    const { ensureTabToken, findTabIdBySession } = await import('@/lib/tab-token');
    await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 'pt-ws-a-pane-1-tab-1');

    expect(findTabIdBySession('ws-a', 'pt-ws-a-pane-1-tab-1')).toBe('tab-1');
    expect(findTabIdBySession('ws-b', 'pt-ws-a-pane-1-tab-1')).toBeNull();
    expect(findTabIdBySession('ws-a', 'pt-ws-a-pane-1-tab-')).toBeNull();
  });

  it('revokes every token of a workspace and only that workspace', async () => {
    const { ensureTabToken, resolveTabToken, revokeWorkspaceTabTokens } = await import('@/lib/tab-token');
    const a1 = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 's1');
    const a2 = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-2' }, 's2');
    const b1 = await ensureTabToken({ workspaceId: 'ws-b', tabId: 'tab-3' }, 's3');

    expect((await revokeWorkspaceTabTokens('ws-a')).sort()).toEqual(['tab-1', 'tab-2']);
    expect(resolveTabToken(a1)).toBeNull();
    expect(resolveTabToken(a2)).toBeNull();
    expect(resolveTabToken(b1)?.tabId).toBe('tab-3');
    expect(Object.keys(JSON.parse(await fs.readFile(tokensPath(), 'utf-8')))).toEqual(['tab-3']);
    expect(await revokeWorkspaceTabTokens('ws-a')).toEqual([]);
  });

  it('emits one workspace-deleted event per token it revokes', async () => {
    const { ensureTabToken, revokeWorkspaceTabTokens } = await import('@/lib/tab-token');
    const { onTabClosed } = await import('@/lib/tab-lifecycle');
    await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 's1');
    const events: unknown[] = [];
    onTabClosed((e) => events.push(e));

    await revokeWorkspaceTabTokens('ws-a');
    expect(events).toEqual([{ workspaceId: 'ws-a', tabId: 'tab-1', sessionName: 's1', reason: 'workspace-deleted' }]);
  });

  it('ignores malformed records instead of trusting them', async () => {
    await fs.mkdir(path.dirname(tokensPath()), { recursive: true });
    await fs.writeFile(tokensPath(), JSON.stringify({
      'tab-good': record('ws-a', 's1'),
      'tab-bad': { token: 'b'.repeat(64) },
    }));
    const { resolveTabToken } = await import('@/lib/tab-token');

    expect(resolveTabToken('a'.repeat(64))?.tabId).toBe('tab-good');
    expect(resolveTabToken('b'.repeat(64))).toBeNull();
  });

  it('revokes on tab-closed once installed, and installing twice adds one listener', async () => {
    const { ensureTabToken, installTabTokenRevocation, resolveTabToken } = await import('@/lib/tab-token');
    const { emitTabClosed, onTabClosed } = await import('@/lib/tab-lifecycle');
    const token = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-1' }, 's1');

    installTabTokenRevocation();
    installTabTokenRevocation();
    const listenerCount = (globalThis as unknown as { __ptTabLifecycle: { listeners: Set<unknown> } })
      .__ptTabLifecycle.listeners.size;
    expect(listenerCount).toBe(1);

    const seen: string[] = [];
    onTabClosed((e) => seen.push(e.tabId));
    emitTabClosed({ workspaceId: 'ws-a', tabId: 'tab-1', sessionName: 's1', reason: 'layout-removed' });

    expect(resolveTabToken(token)).toBeNull();
    expect(seen).toEqual(['tab-1']);
  });
});

describe('planTabTokenSweep', () => {
  const live = (workspaceId: string, tabId: string, sessionName: string): ILiveTab => ({ workspaceId, tabId, sessionName });

  it('keeps the record of a live tab', async () => {
    const { planTabTokenSweep } = await import('@/lib/tab-token');
    const tokens: TTabTokens = { 'tab-1': record('ws-a', 's1') };
    const plan = planTabTokenSweep(tokens, [live('ws-a', 'tab-1', 's1')]);
    expect(plan).toEqual({ keep: tokens, removed: [], rebound: [], detached: [] });
  });

  it('removes the record of a tab that no longer exists', async () => {
    const { planTabTokenSweep } = await import('@/lib/tab-token');
    const plan = planTabTokenSweep({ 'tab-gone': record('ws-a', 's-gone') }, [live('ws-a', 'tab-1', 's1')]);
    expect(plan.keep).toEqual({});
    expect(plan.removed.map((r) => r.tabId)).toEqual(['tab-gone']);
  });

  it('moves the record of an adopted orphan to its new tab id by exact session name', async () => {
    const { planTabTokenSweep } = await import('@/lib/tab-token');
    const rec = record('ws-a', 'pt-ws-a-pane-1-tab-old');
    const plan = planTabTokenSweep({ 'tab-old': rec }, [live('ws-a', 'tab-new', 'pt-ws-a-pane-1-tab-old')]);
    expect(plan.keep).toEqual({ 'tab-new': rec });
    expect(plan.rebound).toEqual([{ fromTabId: 'tab-old', toTabId: 'tab-new', record: rec }]);
    expect(plan.removed).toEqual([]);
  });

  it('never rebinds across workspaces', async () => {
    const { planTabTokenSweep } = await import('@/lib/tab-token');
    const plan = planTabTokenSweep({ 'tab-old': record('ws-a', 'shared-name') }, [live('ws-b', 'tab-new', 'shared-name')]);
    expect(plan.keep).toEqual({});
    expect(plan.removed.map((r) => r.tabId)).toEqual(['tab-old']);
  });

  it('does not overwrite the token an adopted tab already holds', async () => {
    const { planTabTokenSweep } = await import('@/lib/tab-token');
    const own = record('ws-a', 'name', 'c'.repeat(64));
    const stale = record('ws-a', 'name', 'd'.repeat(64));
    const plan = planTabTokenSweep({ 'tab-new': own, 'tab-old': stale }, [live('ws-a', 'tab-new', 'name')]);
    expect(plan.keep).toEqual({ 'tab-new': own });
    expect(plan.removed.map((r) => r.tabId)).toEqual(['tab-old']);
  });

  it('keeps the record of a session that still runs although no layout names it', async () => {
    const { planTabTokenSweep } = await import('@/lib/tab-token');
    const rec = record('ws-a', 'pt-ws-a-pane-1-tab-reset');
    const plan = planTabTokenSweep({ 'tab-reset': rec, 'tab-gone': record('ws-a', 's-gone') }, [], new Set(['pt-ws-a-pane-1-tab-reset']));
    expect(plan.keep).toEqual({ 'tab-reset': rec });
    expect(plan.detached).toEqual([{ tabId: 'tab-reset', record: rec }]);
    expect(plan.removed.map((r) => r.tabId)).toEqual(['tab-gone']);
  });

  it('treats a record whose tab id now lives in another workspace as gone', async () => {
    const { planTabTokenSweep } = await import('@/lib/tab-token');
    const plan = planTabTokenSweep({ 'tab-1': record('ws-a', 's1') }, [live('ws-b', 'tab-1', 's-other')]);
    expect(plan.removed.map((r) => r.tabId)).toEqual(['tab-1']);
  });
});

describe('sweepTabTokens (boot)', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetGlobals();
    logs.info = [];
    logs.warn = [];
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-tab-sweep-'));
    await fs.mkdir(path.dirname(tokensPath()), { recursive: true });
    await fs.writeFile(tokensPath(), JSON.stringify({
      'tab-live': record('ws-a', 's-live', '1'.repeat(64)),
      'tab-gone': record('ws-a', 's-gone', '2'.repeat(64)),
      'tab-old': record('ws-a', 's-adopted', '3'.repeat(64)),
    }));
  });

  afterEach(async () => {
    await (globalThis as { __ptTabTokenLock?: Promise<void> }).__ptTabTokenLock;
    resetGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('removes and logs every token of a vanished tab, rebinds adopted ones, and emits one tab-closed per removal', async () => {
    const { sweepTabTokens, resolveTabToken } = await import('@/lib/tab-token');
    const { onTabClosed } = await import('@/lib/tab-lifecycle');
    const events: unknown[] = [];
    onTabClosed((e) => events.push(e));

    await sweepTabTokens([
      { workspaceId: 'ws-a', tabId: 'tab-live', sessionName: 's-live' },
      { workspaceId: 'ws-a', tabId: 'tab-new', sessionName: 's-adopted' },
    ]);

    expect(resolveTabToken('1'.repeat(64))?.tabId).toBe('tab-live');
    expect(resolveTabToken('2'.repeat(64))).toBeNull();
    expect(resolveTabToken('3'.repeat(64))?.tabId).toBe('tab-new');
    expect(Object.keys(JSON.parse(await fs.readFile(tokensPath(), 'utf-8'))).sort()).toEqual(['tab-live', 'tab-new']);
    expect(logs.info.filter((m) => m.includes('tab token removed at boot'))).toEqual([
      'tab token removed at boot, tab no longer exists: tab-gone (ws-a, s-gone)',
    ]);
    expect(logs.info.some((m) => m.includes('tab-old -> tab-new'))).toBe(true);
    expect(events).toEqual([{ workspaceId: 'ws-a', tabId: 'tab-gone', sessionName: 's-gone', reason: 'boot-sweep' }]);
  });

  it('writes nothing when every token is live', async () => {
    const { sweepTabTokens } = await import('@/lib/tab-token');
    const before = await fs.readFile(tokensPath(), 'utf-8');
    const plan = await sweepTabTokens([
      { workspaceId: 'ws-a', tabId: 'tab-live', sessionName: 's-live' },
      { workspaceId: 'ws-a', tabId: 'tab-gone', sessionName: 's-gone' },
      { workspaceId: 'ws-a', tabId: 'tab-old', sessionName: 's-adopted' },
    ]);
    expect(plan.removed).toEqual([]);
    expect(await fs.readFile(tokensPath(), 'utf-8')).toBe(before);
  });
});
