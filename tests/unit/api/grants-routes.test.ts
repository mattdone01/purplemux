import fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TCliScope } from '@/lib/workspace-token';

// ADR-0014 / story 11: grants are created and revoked ONLY by a human web
// session, from this server's Origin, with the purplemux password. No CLI token
// reaches those routes; the CLI lists read-only. Mission Control producer events
// stay own-workspace even for a grant holder.

const audit = vi.hoisted(() => vi.fn(async (_e: Record<string, unknown>) => {}));
const scopeHolder = vi.hoisted(() => ({ scope: null as TCliScope | null }));
const layouts = vi.hoisted(() => ({ dir: '', idsError: null as Error | null }));

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
  getWorkspaces: vi.fn(async () => ({ workspaces: [{ id: 'ws-1', name: 'Portfolio' }, { id: 'ws-2', name: 'Billing' }] })),
  readWorkspaceIdsStrict: vi.fn(async () => {
    if (layouts.idsError) throw layouts.idsError;
    return ['ws-1', 'ws-2', 'ws-3'];
  }),
}));
vi.mock('@/lib/layout-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/layout-store')>()),
  resolveLayoutFile: (ws: string) => `${layouts.dir}/${ws}.json`,
  readLayoutFile: vi.fn(async (file: string) => (file.endsWith('/ws-1.json') ? { root: {} } : null)),
  collectAllTabs: () => [{ id: 'tab-a', name: 'orch', panelType: 'claude-code' }, { id: 'tab-old', name: 'old' }, { id: 'tab-web', name: 'web', panelType: 'web-browser' }],
}));
vi.mock('@/lib/tab-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tab-token')>()),
  tabIdentityOf: (_ws: string, tab: string) => (tab === 'tab-a' ? 'launch' : 'hook'),
}));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: audit }));
vi.mock('@/lib/workspace-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-token')>()),
  resolveCliScope: () => scopeHolder.scope,
}));

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
  return state as { status: number; body: { grant: { id: string }; grants: unknown[]; code?: string } };
};

const create = (over: Record<string, unknown> = {}, opts: Parameters<typeof call>[2] = {}) =>
  call('@/pages/api/grants', 'POST', { ...opts, body: { granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-a', workspaces: ['ws-2'], reason: 'portfolio', password: 'right', ...over } });

describe('grant routes', () => {
  beforeEach(async () => {
    layouts.idsError = null;
    // ws-1 readable, ws-2 corrupt (unreadable, reported), ws-3 has no layout yet (no tabs).
    layouts.dir = fs.mkdtempSync(`${(await import('os')).tmpdir()}/pmux-grant-layouts-`);
    fs.writeFileSync(`${layouts.dir}/ws-1.json`, JSON.stringify({ root: {} }));
    fs.writeFileSync(`${layouts.dir}/ws-2.json`, '{nope');
    const { grantsFile, reloadGrants } = await import('@/lib/grant-store');
    const { resetStepUp } = await import('@/lib/grant-service');
    fs.rmSync(grantsFile(), { force: true });
    reloadGrants();
    resetStepUp();
    audit.mockClear();
  });
  afterEach(async () => {
    const { grantsFile, reloadGrants } = await import('@/lib/grant-store');
    fs.rmSync(grantsFile(), { force: true });
    reloadGrants();
    fs.rmSync(layouts.dir, { recursive: true, force: true });
  });

  it('refuses any caller without a human session: the admin CLI token alone is 401', async () => {
    const r = await create({}, { cookie: null });
    expect(r).toMatchObject({ status: 401, body: { code: 'unauthorized' } });
    expect((await call('@/pages/api/grants', 'GET', { cookie: null })).status).toBe(401);
  });

  it('GET lists the grants and every grantee tab with its identity (story 28); browser tabs are not grantees', async () => {
    await create();
    // A browser's same-origin GET over plain HTTP to a LAN address carries neither Origin nor
    // Sec-Fetch-Site (story 28 review r1): the read needs the session only.
    const r = await call('@/pages/api/grants', 'GET', { origin: null });
    expect(r.status).toBe(200);
    expect(r.body.grants).toHaveLength(1);
    const body = r.body as unknown as { grantees: unknown[]; unreadableWorkspaceIds: string[]; granteesError: string | null; serverNow: number };
    expect(body.grantees).toEqual([
      { workspaceId: 'ws-1', workspaceName: 'Portfolio', tabId: 'tab-a', name: 'orch', panelType: 'claude-code', identity: 'launch' },
      { workspaceId: 'ws-1', workspaceName: 'Portfolio', tabId: 'tab-old', name: 'old', panelType: 'terminal', identity: 'hook' },
    ]);
    // ws-2's layout is corrupt: reported, never listed as "no tabs"; ws-3 has none yet.
    expect(body.unreadableWorkspaceIds).toEqual(['ws-2']);
    expect(body.granteesError).toBeNull();
    expect(typeof body.serverNow).toBe('number');
    // Strict and read-only: the corrupt layout is not copied aside.
    expect(fs.readdirSync(layouts.dir).sort()).toEqual(['ws-1.json', 'ws-2.json']);
  });

  it('GET with an unreadable workspaces.json still lists the grants and reports the tab-list error', async () => {
    layouts.idsError = new Error('workspaces.json is malformed');
    const r = await call('@/pages/api/grants', 'GET', { origin: null });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ grantees: [], granteesError: 'workspaces.json is malformed' });
  });

  it('GET still needs the human session (401 without it)', async () => {
    expect((await call('@/pages/api/grants', 'GET', { cookie: null, origin: null })).status).toBe(401);
  });

  it('refuses a cross-origin request even with a session (403)', async () => {
    expect((await create({}, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('refuses a wrong or missing password (403 grant-password-invalid) and audits it', async () => {
    expect(await create({ password: 'wrong' })).toMatchObject({ status: 403, body: { code: 'grant-password-invalid' } });
    expect(await create({ password: undefined })).toMatchObject({ status: 403, body: { code: 'grant-password-invalid' } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'grant-password-invalid', by: 'human' }));
  });

  it('creates a grant for a verified tab (201) and refuses one without a launch identity (409)', async () => {
    const ok = await create();
    expect(ok).toMatchObject({ status: 201, body: { grant: { grantee: { workspaceId: 'ws-1', tabId: 'tab-a' }, workspaces: ['ws-2'], createdBy: 'human' } } });
    expect(await create({ granteeTabId: 'tab-old' })).toMatchObject({ status: 409, body: { code: 'grant-tab-unverified' } });
    expect(await create({ workspaces: ['ws-1'] })).toMatchObject({ status: 400, body: { code: 'grant-invalid' } });
  });

  it('revokes with the human session and this server\'s Origin; no password (it only takes power away)', async () => {
    const { body } = await create();
    const id = body.grant.id;
    expect((await call('@/pages/api/grants/[id]', 'DELETE', { cookie: null, query: { id } })).status).toBe(401);
    expect((await call('@/pages/api/grants/[id]', 'DELETE', { query: { id }, origin: 'https://evil.example' })).status).toBe(403);
    const r = await call('@/pages/api/grants/[id]', 'DELETE', { query: { id } });
    expect(r).toMatchObject({ status: 200, body: { grant: { id, revokeReason: 'revoked', revokedBy: 'human' } } });
  });

  it('the human list answers 500 for a malformed store, never an empty list', async () => {
    const { grantsFile, reloadGrants } = await import('@/lib/grant-store');
    fs.writeFileSync(grantsFile(), '{nope');
    reloadGrants();
    expect(await call('@/pages/api/grants', 'GET')).toMatchObject({ status: 500, body: { code: 'grant-store-unreadable' } });
  });

  it('GET /api/cli/grants lists read-only: admin sees all, a workspace sees what it holds or is driven under', async () => {
    await create();
    scopeHolder.scope = { type: 'admin' };
    expect((await call('@/pages/api/cli/grants', 'GET')).body.grants).toHaveLength(1);
    scopeHolder.scope = { type: 'workspace', workspaceId: 'ws-2' };
    expect((await call('@/pages/api/cli/grants', 'GET')).body.grants).toHaveLength(1);
    scopeHolder.scope = { type: 'workspace', workspaceId: 'ws-3' };
    expect((await call('@/pages/api/cli/grants', 'GET')).body.grants).toHaveLength(0);
    scopeHolder.scope = null;
    expect((await call('@/pages/api/cli/grants', 'GET')).status).toBe(403);
    scopeHolder.scope = { type: 'admin' };
    expect((await call('@/pages/api/cli/grants', 'POST')).status).toBe(405);
  });

  it('a malformed grants.json answers 500 on the CLI list rather than an empty list', async () => {
    const { grantsFile, reloadGrants } = await import('@/lib/grant-store');
    fs.writeFileSync(grantsFile(), '{nope');
    reloadGrants();
    scopeHolder.scope = { type: 'admin' };
    expect(await call('@/pages/api/cli/grants', 'GET')).toMatchObject({ status: 500, body: { code: 'grant-store-unreadable' } });
  });

  it('Mission Control producer events stay own-workspace: a grant holder is refused for ws-2 (403)', async () => {
    await create();
    scopeHolder.scope = { type: 'workspace', workspaceId: 'ws-1', tabId: 'tab-a', tabVerified: true, tabIdentity: 'launch' };
    const { canDriveWorkspace } = await import('@/lib/cli-utils');
    expect(canDriveWorkspace(scopeHolder.scope, 'ws-2')).toBe(false);
    const r = await call('@/pages/api/cli/mission-control/events', 'POST', { query: { workspaceId: 'ws-2' }, body: { events: [] } });
    expect(r.status).toBe(403);
  });
});
