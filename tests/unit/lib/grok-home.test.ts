import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

const WS = 'ws-grok-home';

const importFresh = async () => {
  vi.resetModules();
  return {
    home: await import('@/lib/grok-home'),
    store: await import('@/lib/providers/grok/session-store'),
    paths: await import('@/lib/providers/grok/paths'),
  };
};

const seedRealGrokHome = async () => {
  const grok = path.join(mockHome.value, '.grok');
  await fs.mkdir(path.join(grok, 'skills'), { recursive: true });
  await fs.mkdir(path.join(grok, 'commands'), { recursive: true });
  await fs.writeFile(path.join(grok, 'auth.json'), '{"token":"x"}');
  await fs.writeFile(path.join(grok, 'config.toml'), '[compat.claude]\n');
  await fs.writeFile(path.join(grok, 'trusted_folders.toml'), '');
  return grok;
};

beforeEach(async () => {
  mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-grok-home-'));
});

describe('ensureWorkspaceGrokHome', () => {
  it('creates the private dirs the isolation depends on', async () => {
    const { home } = await importFresh();
    await seedRealGrokHome();

    const grokHome = await home.ensureWorkspaceGrokHome(WS);

    expect(grokHome).toBe(path.join(mockHome.value, '.purplemux', 'workspaces', WS, 'grok-home'));
    for (const dir of home.grokPrivateDirs()) {
      expect((await fs.lstat(path.join(grokHome, dir))).isDirectory()).toBe(true);
      expect((await fs.lstat(path.join(grokHome, dir))).isSymbolicLink()).toBe(false);
    }
  });

  it('symlinks credentials, config and the skill surface back to the real ~/.grok', async () => {
    const { home } = await importFresh();
    const real = await seedRealGrokHome();

    const grokHome = await home.ensureWorkspaceGrokHome(WS);

    for (const entry of ['auth.json', 'config.toml', 'trusted_folders.toml', 'skills', 'commands']) {
      const link = path.join(grokHome, entry);
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(link)).toBe(path.join(real, entry));
    }
  });

  it('skips a shared entry the install does not have', async () => {
    const { home } = await importFresh();
    await seedRealGrokHome();

    const grokHome = await home.ensureWorkspaceGrokHome(WS);

    await expect(fs.lstat(path.join(grokHome, 'mcp_credentials.json'))).rejects.toThrow();
  });

  it('leaves a real directory grok wrote under the workspace home alone', async () => {
    const { home } = await importFresh();
    const real = await seedRealGrokHome();

    // No ~/.grok/memory yet, so nothing is linked and grok writes a real one.
    const grokHome = await home.ensureWorkspaceGrokHome(WS);
    const memory = path.join(grokHome, 'memory');
    await fs.mkdir(memory, { recursive: true });
    await fs.writeFile(path.join(memory, 'notes.md'), 'workspace memory');

    // One ad-hoc tab later, the shared entry exists and the link becomes eligible.
    await fs.mkdir(path.join(real, 'memory'), { recursive: true });
    await home.ensureWorkspaceGrokHome(WS);

    expect((await fs.lstat(memory)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(memory, 'notes.md'), 'utf-8')).toBe('workspace memory');
  });

  it('leaves a real file at a shared-entry path alone rather than deleting it', async () => {
    const { home } = await importFresh();
    await seedRealGrokHome();

    const grokHome = await home.ensureWorkspaceGrokHome(WS);
    await fs.rm(path.join(grokHome, 'auth.json'));
    await fs.writeFile(path.join(grokHome, 'auth.json'), '{"token":"local"}');

    await home.ensureWorkspaceGrokHome(WS);

    const stat = await fs.lstat(path.join(grokHome, 'auth.json'));
    expect(stat.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(grokHome, 'auth.json'), 'utf-8')).toBe('{"token":"local"}');
  });

  it('repoints a link that no longer names the shared entry', async () => {
    const { home } = await importFresh();
    const real = await seedRealGrokHome();

    const grokHome = await home.ensureWorkspaceGrokHome(WS);
    const link = path.join(grokHome, 'auth.json');
    await fs.rm(link);
    await fs.symlink(path.join(mockHome.value, 'elsewhere.json'), link);

    await home.ensureWorkspaceGrokHome(WS);

    expect(await fs.readlink(link)).toBe(path.join(real, 'auth.json'));
  });

  it('never links the private session store away from the workspace', async () => {
    const { home } = await importFresh();
    const real = await seedRealGrokHome();
    await fs.mkdir(path.join(real, 'sessions'), { recursive: true });

    const grokHome = await home.ensureWorkspaceGrokHome(WS);

    expect((await fs.lstat(path.join(grokHome, 'sessions'))).isSymbolicLink()).toBe(false);
    expect(home.grokSharedEntries()).not.toContain('sessions');
    expect(home.grokSharedEntries()).not.toContain('hooks');
  });
});

describe('grok home listing and ownership', () => {
  it('lists the unscoped home first, then every workspace home', async () => {
    const { home, paths } = await importFresh();
    await seedRealGrokHome();
    await home.ensureWorkspaceGrokHome(WS);
    await home.ensureWorkspaceGrokHome('ws-second');

    const homes = await home.listGrokHomes();

    expect(homes[0]).toBe(paths.GROK_HOME);
    expect(homes.slice(1).sort()).toEqual([
      home.workspaceGrokHomeDir(WS),
      home.workspaceGrokHomeDir('ws-second'),
    ].sort());
  });

  it('names the owning workspace of a home, and null for the unscoped one', async () => {
    const { home, paths } = await importFresh();

    expect(home.workspaceIdForGrokHome(home.workspaceGrokHomeDir(WS))).toBe(WS);
    expect(home.workspaceIdForGrokHome(paths.GROK_HOME)).toBeNull();
    expect(home.workspaceIdForGrokHome('/somewhere/else')).toBeNull();
  });

  it('removes a workspace home without touching the unscoped one', async () => {
    const { home, paths } = await importFresh();
    await seedRealGrokHome();
    await home.ensureWorkspaceGrokHome(WS);

    await home.removeWorkspaceGrokHome(WS);

    expect(await home.listGrokHomes()).toEqual([paths.GROK_HOME]);
  });
});

describe('grok session store', () => {
  const SESSION_ID = '01a008c1-bb96-71d1-9769-b63ff478fd9f';

  const seedSession = async (grokHome: string, cwd: string, sessionId: string, updates = '') => {
    const dir = path.join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'updates.jsonl'), updates);
    await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({
      info: { id: sessionId, cwd },
      created_at: '2026-08-16T04:08:29.342399252Z',
      updated_at: '2026-08-16T04:08:32.093890659Z',
      num_messages: 4,
      current_model_id: 'grok-4.6',
      generated_title: 'a recorded session',
    }));
    return dir;
  };

  it('reads a session summary the way grok writes it', async () => {
    const { store } = await importFresh();
    const grok = await seedRealGrokHome();
    const dir = await seedSession(grok, '/repo', SESSION_ID);

    expect(await store.readGrokSummary(dir)).toEqual({
      sessionId: SESSION_ID,
      cwd: '/repo',
      title: 'a recorded session',
      model: 'grok-4.6',
      createdAt: '2026-08-16T04:08:29.342399252Z',
      updatedAt: '2026-08-16T04:08:32.093890659Z',
      messageCount: 4,
    });
  });

  it('resolves a group directory\'s cwd from its URL-encoded name', async () => {
    const { store } = await importFresh();
    const grok = await seedRealGrokHome();
    await seedSession(grok, '/repo/deep dir', SESSION_ID);

    const group = path.join(grok, 'sessions', encodeURIComponent('/repo/deep dir'));
    expect(await store.readGrokGroupCwd(group)).toBe('/repo/deep dir');
  });

  it('prefers the .cwd marker grok writes when the encoded name would be too long', async () => {
    const { store } = await importFresh();
    const grok = await seedRealGrokHome();
    const group = path.join(grok, 'sessions', 'slug-abc123');
    await fs.mkdir(group, { recursive: true });
    await fs.writeFile(path.join(group, '.cwd'), '/a/very/long/real/path\n');

    expect(await store.readGrokGroupCwd(group)).toBe('/a/very/long/real/path');
  });

  it('attributes a session to the workspace whose home it sits under', async () => {
    const { home, store } = await importFresh();
    const grok = await seedRealGrokHome();
    const wsHome = await home.ensureWorkspaceGrokHome(WS);
    await seedSession(grok, '/repo', SESSION_ID);
    await seedSession(wsHome, '/repo', '01a008c3-8e98-7220-a0d3-e0b36fa3aa99');

    const sessions = await store.listAllGrokSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.sessionId === SESSION_ID)?.workspaceId).toBeNull();
    expect(sessions.find((s) => s.sessionId !== SESSION_ID)?.workspaceId).toBe(WS);
  });

  it('finds a session by id across every home', async () => {
    const { home, store } = await importFresh();
    await seedRealGrokHome();
    const wsHome = await home.ensureWorkspaceGrokHome(WS);
    const dir = await seedSession(wsHome, '/repo', SESSION_ID);

    const found = await store.findGrokSessionById(SESSION_ID);
    expect(found?.jsonlPath).toBe(path.join(dir, 'updates.jsonl'));
    expect(found?.workspaceId).toBe(WS);
  });

  it('refuses a session id that is not a UUID rather than reading a directory named after it', async () => {
    const { store } = await importFresh();
    expect(await store.findGrokSessionById('../../etc')).toBeNull();
  });

  it('finds the newest session recorded for a working directory', async () => {
    const { store } = await importFresh();
    const grok = await seedRealGrokHome();
    const older = await seedSession(grok, '/repo', SESSION_ID);
    await fs.utimes(path.join(older, 'updates.jsonl'), new Date(1000), new Date(1000));
    const newer = await seedSession(grok, '/repo', '01a008c3-8e98-7220-a0d3-e0b36fa3aa99');

    const found = await store.findLatestGrokSessionForCwd('/repo');
    expect(found?.jsonlPath).toBe(path.join(newer, 'updates.jsonl'));
  });

  it('does not match a session recorded for a different directory', async () => {
    const { store } = await importFresh();
    const grok = await seedRealGrokHome();
    await seedSession(grok, '/repo', SESSION_ID);

    expect(await store.findLatestGrokSessionForCwd('/other')).toBeNull();
  });

  it('skips a session directory that has no transcript yet', async () => {
    const { store } = await importFresh();
    const grok = await seedRealGrokHome();
    await fs.mkdir(path.join(grok, 'sessions', encodeURIComponent('/repo'), SESSION_ID), { recursive: true });

    expect(await store.listAllGrokSessions()).toEqual([]);
  });
});
