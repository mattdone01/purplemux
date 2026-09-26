import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextApiRequest } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILayoutData, ITab } from '@/types/terminal';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});
vi.mock('@/lib/tmux', () => ({
  createSession: vi.fn(async () => {}),
  hasSession: vi.fn(async () => true),
  killSession: vi.fn(async () => {}),
  listSessions: vi.fn(async () => []),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sendKeys: vi.fn(async () => {}),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

const resetGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  for (const key of [
    '__ptTabLifecycle', '__ptTabTokens', '__ptTabTokenLock', '__ptTabTokenRevokeInstalled',
    '__ptLayoutContentCache', '__ptLayoutLock', '__ptWorkspaceTokens', '__ptCliToken',
    '__purplemuxWorkspaceLock', '__purplemuxWorkspacesContentCache',
  ]) delete g[key];
};

const tabOf = (wsId: string, paneId: string, id: string, name = '', sessionTabId = id): ITab => ({
  id,
  sessionName: `pt-${wsId}-${paneId}-${sessionTabId}`,
  name,
  order: 0,
});

const writeLayout = async (wsId: string, tabs: ITab[]) => {
  const dir = path.join(mockHome.value, '.purplemux', 'workspaces', wsId);
  await fs.mkdir(dir, { recursive: true });
  const layout: ILayoutData = {
    root: { type: 'pane', id: 'pane-1', activeTabId: tabs[0]?.id ?? null, tabs },
    activePaneId: 'pane-1',
    updatedAt: '2026-09-26T00:00:00.000Z',
  };
  await fs.writeFile(path.join(dir, 'layout.json'), JSON.stringify(layout));
};

const req = (headers: Record<string, string>): NextApiRequest => ({ headers, query: {} }) as unknown as NextApiRequest;

describe('resolveCaller', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-caller-'));
    await fs.mkdir(path.join(mockHome.value, '.purplemux'), { recursive: true });
    await fs.writeFile(path.join(mockHome.value, '.purplemux', 'workspaces.json'), JSON.stringify({
      workspaces: [
        { id: 'ws-a', name: 'A', directories: ['/a'] },
        { id: 'ws-b', name: 'B', directories: ['/b'] },
      ],
      groups: [],
      sidebarCollapsed: false,
      sidebarWidth: 240,
      updatedAt: '2026-09-26T00:00:00.000Z',
    }));
    await writeLayout('ws-a', [tabOf('ws-a', 'pane-1', 'tab-a1', 'worker'), tabOf('ws-a', 'pane-1', 'tab-a2')]);
    await writeLayout('ws-b', [tabOf('ws-b', 'pane-1', 'tab-b1', 'other')]);
  });

  afterEach(async () => {
    await (globalThis as { __ptTabTokenLock?: Promise<void> }).__ptTabTokenLock;
    resetGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('names the tab of a tab token, verified, with its workspace', async () => {
    const { ensureTabToken } = await import('@/lib/tab-token');
    const { resolveCaller } = await import('@/lib/caller');
    const token = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1');

    expect(await resolveCaller(req({ 'x-pmux-token': token }))).toEqual({
      scope: { type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-a1', tabVerified: true, tabIdentity: 'launch' },
      workspaceId: 'ws-a',
      tabId: 'tab-a1',
      tabName: 'worker',
      verified: true,
      identity: 'launch',
      admin: false,
    });
  });

  describe('hook-time identity (story 36, architect ruling)', () => {
    it('a hook token names its tab, unverified, identity hook', async () => {
      const { mintHookTabToken } = await import('@/lib/tab-token');
      const { resolveCaller } = await import('@/lib/caller');
      const minted = await mintHookTabToken({ workspaceId: 'ws-a', tabId: 'tab-a2' }, 'pt-ws-a-pane-1-tab-a2');
      if (!minted.ok) throw new Error(minted.reason);
      expect(await resolveCaller(req({ 'x-pmux-token': minted.token }))).toEqual({
        scope: { type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-a2', tabIdentity: 'hook' },
        workspaceId: 'ws-a',
        tabId: 'tab-a2',
        tabName: null,
        verified: false,
        identity: 'hook',
        admin: false,
      });
    });

    it('never hands out a launch token: 409-shaped refusal, and the launch token still resolves verified', async () => {
      const { ensureTabToken, mintHookTabToken } = await import('@/lib/tab-token');
      const { resolveCaller } = await import('@/lib/caller');
      const launch = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1');
      expect(await mintHookTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1'))
        .toEqual({ ok: false, reason: 'tab-has-launch-identity' });
      expect(await resolveCaller(req({ 'x-pmux-token': launch }))).toMatchObject({ verified: true, identity: 'launch' });
    });

    it('the ruling\'s disproof test: a sibling tab holding the workspace token CAN take another tab\'s hook token, so it is never verified', async () => {
      // Tab X presents exactly what tab Y's hook presents; the server cannot tell them apart over TCP.
      const { mintHookTabToken } = await import('@/lib/tab-token');
      const { resolveCaller } = await import('@/lib/caller');
      const fromY = await mintHookTabToken({ workspaceId: 'ws-a', tabId: 'tab-a2' }, 'pt-ws-a-pane-1-tab-a2');
      const fromX = await mintHookTabToken({ workspaceId: 'ws-a', tabId: 'tab-a2' }, 'pt-ws-a-pane-1-tab-a2');
      expect(fromX).toEqual(fromY.ok ? { ...fromY, minted: false } : fromY);
      expect(await resolveCaller(req({ 'x-pmux-token': fromY.ok ? fromY.token : '' }))).toMatchObject({ verified: false, identity: 'hook' });
    });

    it('a session the server recreates gets a FRESH launch token; the hook token never becomes verified (review r1)', async () => {
      const { ensureTabToken, mintHookTabToken, tabIdentityOf } = await import('@/lib/tab-token');
      const { resolveCaller } = await import('@/lib/caller');
      const hook = await mintHookTabToken({ workspaceId: 'ws-a', tabId: 'tab-a2' }, 'pt-ws-a-pane-1-tab-a2');
      if (!hook.ok) throw new Error(hook.reason);
      const launch = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a2' }, 'pt-ws-a-pane-1-tab-a2');
      expect(launch).not.toBe(hook.token);
      expect(tabIdentityOf('ws-a', 'tab-a2')).toBe('launch');
      expect(await resolveCaller(req({ 'x-pmux-token': hook.token }))).toBeNull();
      expect(await resolveCaller(req({ 'x-pmux-token': launch }))).toMatchObject({ verified: true, identity: 'launch' });
    });

    it('tab list shows hook only once the token was presented (minting proves only that someone asked)', async () => {
      const { mintHookTabToken, tabIdentityOf } = await import('@/lib/tab-token');
      const { resolveCaller } = await import('@/lib/caller');
      const hook = await mintHookTabToken({ workspaceId: 'ws-a', tabId: 'tab-a2' }, 'pt-ws-a-pane-1-tab-a2');
      expect(tabIdentityOf('ws-a', 'tab-a2')).toBe('none');
      await resolveCaller(req({ 'x-pmux-token': hook.ok ? hook.token : '' }));
      expect(tabIdentityOf('ws-a', 'tab-a2')).toBe('hook');
    });

    it('an unknown origin in the token file never counts as launch proof', async () => {
      const { resolveCaller } = await import('@/lib/caller');
      const token = 'f'.repeat(64);
      await fs.writeFile(path.join(mockHome.value, '.purplemux', 'tab-tokens.json'), JSON.stringify({
        'tab-a1': { token, workspaceId: 'ws-a', sessionName: 'pt-ws-a-pane-1-tab-a1', createdAt: '2026-09-26T00:00:00.000Z', origin: 'forged' },
      }));
      expect(await resolveCaller(req({ 'x-pmux-token': token }))).toMatchObject({ tabId: 'tab-a1', verified: false, identity: 'hook' });
    });
  });

  it('a tab token may drive only its own workspace, and reads obey allowedPeers as before (NFR-1)', async () => {
    const { ensureTabToken } = await import('@/lib/tab-token');
    const { resolveCaller } = await import('@/lib/caller');
    const { canAccessWorkspace, canDriveWorkspace } = await import('@/lib/cli-utils');
    const token = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1');

    const caller = await resolveCaller(req({ 'x-pmux-token': token }));
    expect(canDriveWorkspace(caller!.scope, 'ws-a')).toBe(true);
    expect(canDriveWorkspace(caller!.scope, 'ws-b')).toBe(false);
    expect(await canAccessWorkspace(caller!.scope, 'ws-a')).toBe(true);
    expect(await canAccessWorkspace(caller!.scope, 'ws-b')).toBe(false);
  });

  it('ignores X-Pmux-Session when a tab token names the tab', async () => {
    const { ensureTabToken } = await import('@/lib/tab-token');
    const { resolveCaller } = await import('@/lib/caller');
    const token = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1');

    const caller = await resolveCaller(req({ 'x-pmux-token': token, 'x-pmux-session': 'pt-ws-a-pane-1-tab-a2' }));
    expect(caller).toMatchObject({ tabId: 'tab-a1', verified: true });
  });

  it('names the tab unverified for a workspace token plus a session of that workspace', async () => {
    const { getWorkspaceToken } = await import('@/lib/workspace-token');
    const { resolveCaller } = await import('@/lib/caller');

    const caller = await resolveCaller(req({
      'x-pmux-token': getWorkspaceToken('ws-a'),
      'x-pmux-session': 'pt-ws-a-pane-1-tab-a2',
    }));
    expect(caller).toEqual({
      scope: { type: 'workspace', workspaceId: 'ws-a' },
      workspaceId: 'ws-a',
      tabId: 'tab-a2',
      tabName: null,
      verified: false,
      identity: 'session',
      admin: false,
    });
  });

  it('ignores a session of ANOTHER workspace rather than trusting it', async () => {
    const { getWorkspaceToken } = await import('@/lib/workspace-token');
    const { resolveCaller } = await import('@/lib/caller');

    const caller = await resolveCaller(req({
      'x-pmux-token': getWorkspaceToken('ws-a'),
      'x-pmux-session': 'pt-ws-b-pane-1-tab-b1',
    }));
    expect(caller).toMatchObject({ workspaceId: 'ws-a', tabId: null, tabName: null, verified: false, identity: 'none' });
  });

  it('ignores a session name that no layout holds', async () => {
    const { getWorkspaceToken } = await import('@/lib/workspace-token');
    const { resolveCaller } = await import('@/lib/caller');

    for (const value of ['pt-ws-a-pane-1-tab-nope', 'garbage', '  ']) {
      const caller = await resolveCaller(req({ 'x-pmux-token': getWorkspaceToken('ws-a'), 'x-pmux-session': value }));
      expect(caller).toMatchObject({ workspaceId: 'ws-a', tabId: null, verified: false });
    }
  });

  it('is a workspace caller with no tab when the session header is absent', async () => {
    const { getWorkspaceToken } = await import('@/lib/workspace-token');
    const { resolveCaller } = await import('@/lib/caller');

    expect(await resolveCaller(req({ 'x-pmux-token': getWorkspaceToken('ws-b') }))).toMatchObject({
      workspaceId: 'ws-b', tabId: null, verified: false, admin: false,
    });
  });

  it('labels the global token admin, never a human, and never names a tab', async () => {
    const { getCliToken } = await import('@/lib/cli-token');
    const { resolveCaller } = await import('@/lib/caller');

    const caller = await resolveCaller(req({ 'x-pmux-token': getCliToken(), 'x-pmux-session': 'pt-ws-a-pane-1-tab-a1' }));
    expect(caller).toEqual({
      scope: { type: 'admin' }, workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true,
    });
    expect(Object.keys(caller!)).not.toContain('human');
  });

  it('returns null for a missing or unknown token', async () => {
    const { resolveCaller } = await import('@/lib/caller');
    expect(await resolveCaller(req({}))).toBeNull();
    expect(await resolveCaller(req({ 'x-pmux-token': 'f'.repeat(64) }))).toBeNull();
  });

  it('returns null for a closed tab\'s token', async () => {
    const { ensureTabToken, installTabTokenRevocation } = await import('@/lib/tab-token');
    const { emitTabClosed } = await import('@/lib/tab-lifecycle');
    const { resolveCaller } = await import('@/lib/caller');
    const token = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1');
    installTabTokenRevocation();

    emitTabClosed({ workspaceId: 'ws-a', tabId: 'tab-a1', sessionName: 'pt-ws-a-pane-1-tab-a1', reason: 'layout-removed' });
    expect(await resolveCaller(req({ 'x-pmux-token': token }))).toBeNull();
  });

  describe('an orphan session adopted at boot (new tab id, old session name)', () => {
    beforeEach(async () => {
      await writeLayout('ws-a', [tabOf('ws-a', 'pane-1', 'tab-adopted', '', 'tab-old')]);
    });

    it('resolves to the adopted tab through findTabBySessionName for a pre-token tab', async () => {
      const { getWorkspaceToken } = await import('@/lib/workspace-token');
      const { resolveCaller } = await import('@/lib/caller');

      const caller = await resolveCaller(req({
        'x-pmux-token': getWorkspaceToken('ws-a'),
        'x-pmux-session': 'pt-ws-a-pane-1-tab-old',
      }));
      expect(caller).toMatchObject({ tabId: 'tab-adopted', verified: false });
    });

    it('rebinds the orphan\'s tab token to the adopted tab at the boot sweep', async () => {
      const { ensureTabToken, initTabTokens } = await import('@/lib/tab-token');
      const { resolveCaller } = await import('@/lib/caller');
      const token = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-old' }, 'pt-ws-a-pane-1-tab-old');

      await initTabTokens();

      expect(await resolveCaller(req({ 'x-pmux-token': token }))).toMatchObject({
        workspaceId: 'ws-a', tabId: 'tab-adopted', verified: true,
      });
    });
  });
});
