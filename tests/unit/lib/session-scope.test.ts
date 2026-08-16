import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { buildSessionKey } from '@/lib/session-key';
import { isWithinDirectory, scopeForCwd, sessionScopeFor, type ISessionScope } from '@/lib/session-scope';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src');

const scope = (id: string, directories: string[]): ISessionScope => ({
  id,
  name: id,
  workspaceId: id,
  directories,
});

const SCOPES: ISessionScope[] = [
  { id: 'global', name: 'global', workspaceId: null, directories: [] },
  scope('ws-alpha', ['/work/alpha']),
  scope('ws-nested', ['/work/alpha/packages/inner']),
  scope('ws-beta', ['/work/beta']),
];

describe('isWithinDirectory', () => {
  it('accepts the directory itself and anything under it', () => {
    expect(isWithinDirectory('/work/alpha', '/work/alpha')).toBe(true);
    expect(isWithinDirectory('/work/alpha', '/work/alpha/src/deep')).toBe(true);
    expect(isWithinDirectory('/work/alpha/', '/work/alpha/src')).toBe(true);
  });

  it('rejects a sibling whose path merely shares a prefix', () => {
    expect(isWithinDirectory('/work/alpha', '/work/alpha-two')).toBe(false);
    expect(isWithinDirectory('/work/alpha', '/work')).toBe(false);
  });
});

describe('scopeForCwd', () => {
  it('attributes a session started in a subdirectory to the workspace above it', () => {
    expect(scopeForCwd(SCOPES, '/work/alpha/src/lib')?.id).toBe('ws-alpha');
  });

  it('gives a nested workspace root the session started under it', () => {
    expect(scopeForCwd(SCOPES, '/work/alpha/packages/inner/src')?.id).toBe('ws-nested');
  });

  it('returns null for a directory no workspace lists, and for no directory at all', () => {
    expect(scopeForCwd(SCOPES, '/tmp/elsewhere')).toBeNull();
    expect(scopeForCwd(SCOPES, null)).toBeNull();
  });
});

describe('sessionScopeFor', () => {
  // Grok Build isolates by GROK_HOME, so the home names the workspace and the
  // cwd never reaches the key — an ad-hoc tab under ~/.grok stays global even
  // when its cwd sits inside a workspace root (fork ADR-0005, revised).
  it('keys a grok session by the GROK_HOME it was recorded in, not by its cwd', () => {
    for (const cwd of ['/work/alpha', '/work/beta/src', null]) {
      const unscoped = sessionScopeFor({ provider: 'grok', scopes: SCOPES, cwd, workspaceId: null });
      expect(unscoped.workspaceId).toBeNull();
      expect(buildSessionKey({ provider: 'grok', workspaceId: unscoped.workspaceId, sessionId: 's1' }))
        .toBe('grok:global:s1');

      const scoped = sessionScopeFor({ provider: 'grok', scopes: SCOPES, cwd, workspaceId: 'ws-beta' });
      expect(buildSessionKey({ provider: 'grok', workspaceId: scoped.workspaceId, sessionId: 's1' }))
        .toBe('grok:ws-beta:s1');
    }
  });

  it('names a grok workspace whose scope is no longer configured rather than dropping it', () => {
    const resolved = sessionScopeFor({ provider: 'grok', scopes: SCOPES, workspaceId: 'ws-deleted' });
    expect(resolved).toMatchObject({ id: 'ws-deleted', workspaceId: 'ws-deleted' });
  });

  it('agrees on a codex session in a subdirectory however the caller reaches it', () => {
    const fromCwd = sessionScopeFor({ provider: 'codex', scopes: SCOPES, cwd: '/work/alpha/src/lib' });
    const fromRequest = sessionScopeFor({
      provider: 'codex',
      scopes: SCOPES,
      cwd: '/work/alpha/src/lib',
      workspaceId: 'ws-beta',
    });

    expect(fromCwd.workspaceId).toBe('ws-alpha');
    expect(fromRequest.workspaceId).toBe('ws-alpha');
  });

  it('sends a codex session under no workspace directory to the global scope', () => {
    expect(sessionScopeFor({ provider: 'codex', scopes: SCOPES, cwd: '/tmp/scratch' }).workspaceId).toBeNull();
  });

  it('keys claude by its claude-home, and by the requested id even when unlisted', () => {
    expect(sessionScopeFor({ provider: 'claude', scopes: SCOPES, workspaceId: 'ws-alpha' }).workspaceId)
      .toBe('ws-alpha');
    expect(sessionScopeFor({ provider: 'claude', scopes: SCOPES, workspaceId: 'ws-orphan' }).workspaceId)
      .toBe('ws-orphan');
    expect(sessionScopeFor({ provider: 'claude', scopes: SCOPES, workspaceId: null }).workspaceId).toBeNull();
  });
});

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

/**
 * One session must not get two keys depending on which route produced it, so the
 * workspace segment has exactly one derivation and every builder goes through it.
 */
describe('one derivation, three routes', () => {
  const files = sourceFiles(SRC);
  const relative = (file: string) => path.relative(SRC, file);

  it('defines the scope derivation in exactly one module', () => {
    const definers = files.filter((file) => (
      /(const|function)\s+(sessionScopeFor|scopeForCwd)\b/.test(fs.readFileSync(file, 'utf-8'))
    ));

    expect(definers.map(relative)).toEqual(['lib/session-scope.ts']);
  });

  it('makes every sessionKey builder derive its scope through that module', () => {
    const builders = files.filter((file) => (
      file !== path.join(SRC, 'lib', 'session-key.ts')
      && fs.readFileSync(file, 'utf-8').includes('buildSessionKey(')
    ));

    expect(builders.length).toBeGreaterThanOrEqual(3);
    for (const file of builders) {
      expect(fs.readFileSync(file, 'utf-8'), relative(file)).toContain('sessionScopeFor');
    }
  });
});
