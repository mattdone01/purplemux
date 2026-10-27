import fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TCliScope } from '@/lib/workspace-token';

// ADR-0029 / story 05: the owner grant is made only through the human gate (web
// session, this server's Origin, the purplemux password), lives in its own file,
// owner-grants.json, and is listed beside the drive grants by both GET routes.

const audit = vi.hoisted(() => vi.fn(async (_e: Record<string, unknown>) => {}));
const scopeHolder = vi.hoisted(() => ({ scope: null as TCliScope | null }));
const layouts = vi.hoisted(() => ({ dir: '' }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  verifySessionToken: vi.fn(async (token: string) => (token === 'good-session' ? { sub: 'human' } : null)),
}));
vi.mock('@/lib/config-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config-store')>()),
  readConfig: vi.fn(async () => ({ authPassword: 'scrypt:stored' })),
  verifyPassword: vi.fn(async (plain: string) => plain === 'right'),
}));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: vi.fn(async (id: string) => (['ws-1', 'ws-2', 'ws-3'].includes(id) ? { id } : null)),
  getWorkspaces: vi.fn(async () => ({ workspaces: [{ id: 'ws-1', name: 'Owner' }, { id: 'ws-2', name: 'Billing' }] })),
  readWorkspaceIdsStrict: vi.fn(async () => ['ws-1', 'ws-2', 'ws-3']),
}));
vi.mock('@/lib/layout-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/layout-store')>()),
  resolveLayoutFile: (ws: string) => `${layouts.dir}/${ws}.json`,
  readLayoutFile: vi.fn(async (file: string) => (file.endsWith('/ws-1.json') ? { root: {} } : null)),
  collectAllTabs: () => [{ id: 'tab-o', name: 'owner', panelType: 'claude-code' }, { id: 'tab-a', name: 'orch', panelType: 'claude-code' }, { id: 'tab-old', name: 'old' }, { id: 'tab-none', name: 'shell' }],
}));
vi.mock('@/lib/tab-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tab-token')>()),
  tabIdentityOf: (_ws: string, tab: string) => (tab === 'tab-old' ? 'hook' : tab === 'tab-none' ? 'none' : 'launch'),
}));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: audit }));
vi.mock('@/lib/workspace-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-token')>()),
  resolveCliScope: () => scopeHolder.scope,
}));

type TBody = {
  grant: { id: string; capability: string; workspaces: string[]; expiresAt: number; createdAt: number };
  grants: Array<{ id: string; capability: string }>;
  code?: string;
  error?: string;
};

const call = async (
  route: string,
  method: string,
  { cookie = 'good-session', origin = 'http://localhost:8022', body = {}, query = {} }: { cookie?: string | null; origin?: string | null; body?: unknown; query?: Record<string, string> } = {},
) => {
  const { default: handler } = await import(route);
  const state = { status: 0, body: undefined as unknown };
  const res = {
    status(c: number) { state.status = c; return this; },
    json(b: unknown) { state.body = b; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  const headers: Record<string, string> = { host: 'localhost:8022', 'x-pmux-token': 'admin-cli-token' };
  if (cookie) headers.cookie = `session-token=${cookie}`;
  if (origin) headers.origin = origin;
  await handler({ method, headers, body, query, socket: {} } as unknown as NextApiRequest, res);
  return state as { status: number; body: TBody };
};

const createOwner = (over: Record<string, unknown> = {}, opts: Parameters<typeof call>[2] = {}) =>
  call('@/pages/api/grants', 'POST', { ...opts, body: { capability: 'owner', granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-o', reason: 'owner session', password: 'right', ...over } });

const createDrive = () =>
  call('@/pages/api/grants', 'POST', { body: { granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-a', workspaces: ['ws-2'], reason: 'portfolio', password: 'right' } });

const clean = async () => {
  const { grantsFile, ownerGrantsFile, reloadGrants } = await import('@/lib/grant-store');
  fs.rmSync(grantsFile(), { force: true });
  fs.rmSync(ownerGrantsFile(), { force: true });
  reloadGrants();
};

describe('owner grant routes (ADR-0029)', () => {
  beforeEach(async () => {
    layouts.dir = fs.mkdtempSync(`${(await import('os')).tmpdir()}/pmux-owner-layouts-`);
    fs.writeFileSync(`${layouts.dir}/ws-1.json`, JSON.stringify({ root: {} }));
    await clean();
    (await import('@/lib/grant-service')).resetStepUp();
    audit.mockClear();
    scopeHolder.scope = null;
  });
  afterEach(async () => {
    await clean();
    fs.rmSync(layouts.dir, { recursive: true, force: true });
  });

  it('creates one owner grant with workspaces ["*"], 24 h by default, in owner-grants.json (0600), and audits it', async () => {
    const r = await createOwner();
    expect(r.status).toBe(201);
    expect(r.body.grant).toMatchObject({ capability: 'owner', workspaces: ['*'], grantee: { workspaceId: 'ws-1', tabId: 'tab-o' }, createdBy: 'human' });
    expect(r.body.grant.expiresAt - r.body.grant.createdAt).toBe(24 * 60 * 60 * 1000);
    const { grantsFile, ownerGrantsFile } = await import('@/lib/grant-store');
    expect(fs.existsSync(grantsFile())).toBe(false);
    expect(fs.statSync(ownerGrantsFile()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(ownerGrantsFile(), 'utf-8')).grants.map((g: { id: string }) => g.id)).toEqual([r.body.grant.id]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      event: 'grant-created', grantId: r.body.grant.id, capability: 'owner', workspaces: ['*'], by: 'human',
    }));
  });

  it('leaves grants.json byte-identical: an owner grant is never written to the drive file (ruling R3)', async () => {
    await createDrive();
    const { grantsFile } = await import('@/lib/grant-store');
    const before = fs.readFileSync(grantsFile());
    expect((await createOwner()).status).toBe(201);
    const id = (await call('@/pages/api/grants', 'GET')).body.grants.find((g) => g.capability === 'owner')!.id;
    expect((await call('@/pages/api/grants/[id]', 'DELETE', { query: { id } })).status).toBe(200);
    expect(fs.readFileSync(grantsFile()).equals(before)).toBe(true);
  });

  it('takes the expiry up to 7 days and refuses more, zero, a workspace list or an unknown capability (400 grant-invalid)', async () => {
    const week = await createOwner({ expiresInHours: 168 });
    expect(week.body.grant.expiresAt - week.body.grant.createdAt).toBe(168 * 60 * 60 * 1000);
    await clean();
    for (const over of [{ expiresInHours: 169 }, { expiresInHours: 0 }, { workspaces: ['ws-2'] }, { workspaces: [] }, { reason: ' ' }, { capability: 'admin' }]) {
      expect(await createOwner(over)).toMatchObject({ status: 400, body: { code: 'grant-invalid' } });
    }
    expect((await createOwner({ workspaces: ['*'] })).status).toBe(201);
  });

  it('refuses "*" on a drive grant (400 grant-invalid)', async () => {
    const r = await call('@/pages/api/grants', 'POST', { body: { granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-a', workspaces: ['*'], reason: 'r', password: 'right' } });
    expect(r).toMatchObject({ status: 400, body: { code: 'grant-invalid' } });
  });

  it('refuses without a session (401), from another Origin (403) or with a wrong password (403); 5 wrong lock it (429)', async () => {
    expect(await createOwner({}, { cookie: null })).toMatchObject({ status: 401, body: { code: 'unauthorized' } });
    expect((await createOwner({}, { origin: 'https://evil.example' })).status).toBe(403);
    for (let i = 0; i < 5; i += 1) {
      expect(await createOwner({ password: 'wrong' })).toMatchObject({ status: 403, body: { code: 'grant-password-invalid' } });
    }
    expect(await createOwner()).toMatchObject({ status: 429, body: { code: 'grant-locked' } });
    const { ownerGrantsFile } = await import('@/lib/grant-store');
    expect(fs.existsSync(ownerGrantsFile())).toBe(false);
  });

  it('no CLI token creates one: any CLI scope without the human session is 401', async () => {
    for (const scope of [{ type: 'admin' }, { type: 'workspace', workspaceId: 'ws-1', tabId: 'tab-o', tabVerified: true, tabIdentity: 'launch' }] as TCliScope[]) {
      scopeHolder.scope = scope;
      expect((await createOwner({}, { cookie: null })).status).toBe(401);
    }
    expect((await call('@/pages/api/cli/grants', 'POST')).status).toBe(405);
  });

  it('refuses a second owner grant (409 grant-owner-active) until the first is revoked', async () => {
    const first = await createOwner();
    const second = await createOwner({ granteeTabId: 'tab-a' });
    expect(second).toMatchObject({ status: 409, body: { code: 'grant-owner-active' } });
    expect(second.body.error).toContain(first.body.grant.id);
    expect((await call('@/pages/api/grants/[id]', 'DELETE', { query: { id: first.body.grant.id } })).status).toBe(200);
    expect((await createOwner({ granteeTabId: 'tab-a' })).status).toBe(201);
  });

  it('refuses a grantee with a hook-time identity or none (409 grant-tab-unverified)', async () => {
    expect(await createOwner({ granteeTabId: 'tab-old' })).toMatchObject({ status: 409, body: { code: 'grant-tab-unverified' } });
    expect(await createOwner({ granteeTabId: 'tab-none' })).toMatchObject({ status: 409, body: { code: 'grant-tab-unverified' } });
  });

  it('GET /api/grants and GET /api/cli/grants list both files with their capability', async () => {
    await createDrive();
    await createOwner();
    const human = await call('@/pages/api/grants', 'GET');
    expect(human.status).toBe(200);
    expect(human.body.grants.map((g) => g.capability)).toEqual(['drive', 'owner']);
    scopeHolder.scope = { type: 'admin' };
    expect((await call('@/pages/api/cli/grants', 'GET')).body.grants.map((g) => g.capability)).toEqual(['drive', 'owner']);
    // ws-3 neither holds nor is named by the drive grant, but the owner grant reads every workspace.
    scopeHolder.scope = { type: 'workspace', workspaceId: 'ws-3' };
    expect((await call('@/pages/api/cli/grants', 'GET')).body.grants.map((g) => g.capability)).toEqual(['owner']);
  });

  it('an unreadable owner-grants.json is named in refused while the drive grants still list; it refuses owner creation, never drive creation', async () => {
    await createDrive();
    const { ownerGrantsFile, reloadGrants } = await import('@/lib/grant-store');
    fs.writeFileSync(ownerGrantsFile(), '{nope');
    reloadGrants();
    const refusedOwner = [{ capability: 'owner', file: 'owner-grants.json', code: 'grant-store-unreadable', error: expect.stringContaining('owner-grants.json is malformed') }];
    const human = await call('@/pages/api/grants', 'GET');
    expect(human).toMatchObject({ status: 200, body: { refused: refusedOwner } });
    expect(human.body.grants.map((g) => g.capability)).toEqual(['drive']);
    scopeHolder.scope = { type: 'admin' };
    const cli = await call('@/pages/api/cli/grants', 'GET');
    expect(cli).toMatchObject({ status: 200, body: { refused: refusedOwner } });
    expect(cli.body.grants.map((g) => g.capability)).toEqual(['drive']);
    expect(await createOwner()).toMatchObject({ status: 500, body: { code: 'grant-store-unreadable' } });
    expect((await createDrive()).status).toBe(201);
    expect(fs.readFileSync(ownerGrantsFile(), 'utf-8')).toBe('{nope');
  });
});
