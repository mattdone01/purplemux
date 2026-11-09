import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0044: the registry is the grant. It fails closed, stores only token hashes, and the token
// reaches only the 0600 token file.

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const load = () => import('@/lib/service-senders');
const registry = () => path.join(mockHome.value, '.purplemux', 'service-senders.json');
const writeRegistry = async (senders: unknown[]) => {
  await fs.mkdir(path.dirname(registry()), { recursive: true });
  await fs.writeFile(registry(), JSON.stringify({ senders }), { mode: 0o600 });
};

describe('service-sender registry (ADR-0044)', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__ptServiceSenders;
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-svc-'));
  });

  afterEach(async () => {
    delete (globalThis as Record<string, unknown>).__ptServiceSenders;
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('grants one sender: the token goes only to a 0600 file and the registry holds its hash', async () => {
    const { grantServiceSender, resolveServiceToken, serviceGrantActive } = await load();
    const tokenFile = path.join(mockHome.value, 'tok');
    const grant = grantServiceSender({ name: 'improve-lessons', workspaceId: 'ws-L7eUOX', noteTarget: 'ws-zOfVyu' }, tokenFile);
    expect(grant).toEqual({ name: 'improve-lessons', workspaceId: 'ws-L7eUOX', noteTarget: 'ws-zOfVyu' });
    const token = (await fs.readFile(tokenFile, 'utf-8')).trim();
    expect((await fs.stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(registry())).mode & 0o777).toBe(0o600);
    const stored = await fs.readFile(registry(), 'utf-8');
    expect(stored).not.toContain(token);
    expect(JSON.parse(stored).senders[0].tokenSha256).toBe(sha(token));
    expect(resolveServiceToken(token)).toEqual(grant);
    expect(serviceGrantActive('improve-lessons', 'ws-L7eUOX', 'ws-zOfVyu')).toBe(true);
    expect(serviceGrantActive('improve-lessons', 'ws-L7eUOX', 'ws-other')).toBe(false);
  });

  it('a re-grant rotates the token: the old token stops resolving', async () => {
    const { grantServiceSender, resolveServiceToken } = await load();
    const tokenFile = path.join(mockHome.value, 'tok');
    grantServiceSender({ name: 'svc', workspaceId: 'ws-a', noteTarget: 'ws-b' }, tokenFile);
    const first = (await fs.readFile(tokenFile, 'utf-8')).trim();
    grantServiceSender({ name: 'svc', workspaceId: 'ws-a', noteTarget: 'ws-c' }, tokenFile);
    const second = (await fs.readFile(tokenFile, 'utf-8')).trim();
    expect(resolveServiceToken(first)).toBeNull();
    expect(resolveServiceToken(second)).toMatchObject({ noteTarget: 'ws-c' });
    expect(JSON.parse(await fs.readFile(registry(), 'utf-8')).senders).toHaveLength(1);
  });

  it('refuses a grant to its own workspace or with a bad name or id', async () => {
    const { grantServiceSender } = await load();
    const tokenFile = path.join(mockHome.value, 'tok');
    expect(() => grantServiceSender({ name: 'svc', workspaceId: 'ws-a', noteTarget: 'ws-a' }, tokenFile)).toThrow(/another workspace/);
    expect(() => grantServiceSender({ name: 'Bad Name', workspaceId: 'ws-a', noteTarget: 'ws-b' }, tokenFile)).toThrow(/name/);
    expect(() => grantServiceSender({ name: 'svc', workspaceId: 'a', noteTarget: 'ws-b' }, tokenFile)).toThrow(/workspace ids/);
    await expect(fs.stat(tokenFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('drops invalid entries and every entry that shares a name or a token hash', async () => {
    await writeRegistry([
      { name: 'ok', workspaceId: 'ws-a', noteTarget: 'ws-b', tokenSha256: sha('t-ok') },
      { name: 'self', workspaceId: 'ws-a', noteTarget: 'ws-a', tokenSha256: sha('t-self') },
      { name: 'nohash', workspaceId: 'ws-a', noteTarget: 'ws-b', tokenSha256: 'x' },
      { name: 'dup', workspaceId: 'ws-a', noteTarget: 'ws-b', tokenSha256: sha('t-dup1') },
      { name: 'dup', workspaceId: 'ws-a', noteTarget: 'ws-c', tokenSha256: sha('t-dup2') },
      { name: 'same1', workspaceId: 'ws-a', noteTarget: 'ws-b', tokenSha256: sha('t-same') },
      { name: 'same2', workspaceId: 'ws-c', noteTarget: 'ws-b', tokenSha256: sha('t-same') },
    ]);
    const { readServiceSenders, resolveServiceToken } = await load();
    expect(readServiceSenders().map((e) => e.name)).toEqual(['ok']);
    for (const t of ['t-self', 't-dup1', 't-dup2', 't-same']) expect(resolveServiceToken(t)).toBeNull();
    expect(resolveServiceToken('t-ok')).toMatchObject({ name: 'ok' });
  });

  it('fails closed on a missing, unparsable, or group-writable registry', async () => {
    const { resolveServiceToken } = await load();
    expect(resolveServiceToken('t-ok')).toBeNull();
    await fs.mkdir(path.dirname(registry()), { recursive: true });
    await fs.writeFile(registry(), '{not json', { mode: 0o600 });
    expect(resolveServiceToken('t-ok')).toBeNull();
    await writeRegistry([{ name: 'ok', workspaceId: 'ws-a', noteTarget: 'ws-b', tokenSha256: sha('t-ok') }]);
    expect(resolveServiceToken('t-ok')).toMatchObject({ name: 'ok' });
    await fs.chmod(registry(), 0o660);
    expect(resolveServiceToken('t-ok')).toBeNull();
  });

  it('revoke removes only the named entry', async () => {
    await writeRegistry([
      { name: 'a', workspaceId: 'ws-a', noteTarget: 'ws-b', tokenSha256: sha('t-a') },
      { name: 'b', workspaceId: 'ws-a', noteTarget: 'ws-b', tokenSha256: sha('t-b') },
    ]);
    const { revokeServiceSender, resolveServiceToken } = await load();
    expect(revokeServiceSender('a')).toBe(true);
    expect(revokeServiceSender('a')).toBe(false);
    expect(resolveServiceToken('t-a')).toBeNull();
    expect(resolveServiceToken('t-b')).toMatchObject({ name: 'b' });
  });
});
