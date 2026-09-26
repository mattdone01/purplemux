import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, drainRouteLocks, loadLeaseRoutes, resetRouteGlobals, writeFixture } from './leases-harness';

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

let routes: Awaited<ReturnType<typeof loadLeaseRoutes>>;
let tok: { a: string; b: string; orch: string; wsB: string; admin: string };

const as = (token: string, extra: Record<string, string> = {}) => ({ 'x-pmux-token': token, ...extra });
const get = (route: string, token: string, query: Record<string, string> = {}, extra?: Record<string, string>) =>
  callRoute(routes[route], { method: 'GET', headers: as(token, extra), query });
const post = (route: string, token: string, body: unknown, extra?: Record<string, string>) =>
  callRoute(routes[route], { method: 'POST', headers: as(token, extra), body });

describe('lease routes', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-lease-routes-'));
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'Alpha', tabs: [{ id: 'tab-a', name: 'worker A' }, { id: 'tab-o', name: 'orch' }], orchestratorTabId: 'tab-o' },
      { id: 'ws-b', name: 'Beta', tabs: [{ id: 'tab-b', name: 'worker B' }, { id: 'tab-old', name: 'legacy' }] },
    ]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    const { getWorkspaceToken } = await import('@/lib/workspace-token');
    const { getCliToken } = await import('@/lib/cli-token');
    tok = {
      a: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a' }, 'pt-ws-a-pane-1-tab-a'),
      orch: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-o' }, 'pt-ws-a-pane-1-tab-o'),
      b: await ensureTabToken({ workspaceId: 'ws-b', tabId: 'tab-b' }, 'pt-ws-b-pane-1-tab-b'),
      wsB: getWorkspaceToken('ws-b'),
      admin: getCliToken(),
    };
    routes = await loadLeaseRoutes();
  });

  afterEach(async () => {
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  describe('check — the contract bash-guard parses', () => {
    it('answers exactly { held, mine, lease } by exact name', async () => {
      await post('/api/cli/leases/acquire', tok.a, { name: 'merge:x/y' });

      const fromB = await get('/api/cli/leases/check', tok.b, { name: 'merge:x/y' });
      expect(fromB.status).toBe(200);
      expect(Object.keys(fromB.body).sort()).toEqual(['held', 'lease', 'mine']);
      expect(fromB.body).toMatchObject({ held: true, mine: false, lease: { name: 'merge:x/y', holder: { workspaceId: 'ws-a', workspaceName: 'Alpha', tabId: 'tab-a', tabName: 'worker A', verified: true, admin: false }, holderState: 'live' } });

      expect((await get('/api/cli/leases/check', tok.a, { name: 'MERGE:x/Y' })).body).toMatchObject({ held: true, mine: true });
      expect((await get('/api/cli/leases/check', tok.a, { name: 'merge:x/y-z' })).body).toEqual({ held: false, mine: false, lease: null });
    });

    it('lets any valid scope check, and names mine only for a resolved holder', async () => {
      await post('/api/cli/leases/acquire', tok.a, { name: 'merge:x/y' });
      expect((await get('/api/cli/leases/check', tok.wsB, { name: 'merge:x/y' })).body).toMatchObject({ held: true, mine: false });
      expect((await get('/api/cli/leases/check', tok.admin, { name: 'merge:x/y' })).body).toMatchObject({ held: true, mine: false });
    });

    it('refuses a malformed name with lease-policy', async () => {
      expect(await get('/api/cli/leases/check', tok.a, { name: 'nope' })).toMatchObject({ status: 400, body: { code: 'lease-policy' } });
    });
  });

  describe('acquire', () => {
    it('refuses a second holder with lease-held naming workspace, tab and age', async () => {
      await post('/api/cli/leases/acquire', tok.a, { name: 'merge:x/y' });
      const second = await post('/api/cli/leases/acquire', tok.b, { name: 'merge:x/y' });

      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: 'lease-held', holder: { workspaceId: 'ws-a', tabId: 'tab-a', workspaceName: 'Alpha' }, lease: { name: 'merge:x/y' } });
      expect(second.body.error).toMatch(/^merge:x\/y is held by ws-a\/tab-a \(worker A\) for \d+s$/);
    });

    it('renews for the holder', async () => {
      const first = await post('/api/cli/leases/acquire', tok.a, { name: 'merge:x/y', ttlSeconds: 600 });
      const again = await post('/api/cli/leases/acquire', tok.a, { name: 'merge:x/y' });
      expect(first.body.outcome).toBe('acquired');
      expect(again.body).toMatchObject({ outcome: 'renewed', lease: { ttlSeconds: 600 } });
    });

    it('refuses policy violations with lease-policy (400)', async () => {
      expect(await post('/api/cli/leases/acquire', tok.a, { name: 'num:x/y:adr:0001' })).toMatchObject({ status: 400, body: { code: 'lease-policy', error: 'num leases require an epic' } });
      expect(await post('/api/cli/leases/acquire', tok.a, { name: 'merge:x/y', ttlSeconds: 'soon' })).toMatchObject({ status: 400, body: { code: 'lease-policy' } });
    });

    it('lets only the workspace orchestrator tab or admin take deploy', async () => {
      expect((await post('/api/cli/leases/acquire', tok.a, { name: 'deploy:purplemux' })).body).toMatchObject({ code: 'lease-policy' });
      expect((await post('/api/cli/leases/acquire', tok.orch, { name: 'deploy:purplemux' })).status).toBe(200);
      await post('/api/cli/leases/release', tok.orch, { name: 'deploy:purplemux' });
      expect((await post('/api/cli/leases/acquire', tok.admin, { name: 'deploy:purplemux', ttlSeconds: 1800 })).body).toMatchObject({ lease: { holder: { admin: true }, holderState: 'admin' } });
    });

    it('records a pre-token tab as unverified, resolved from X-Pmux-Session', async () => {
      const res = await post('/api/cli/leases/acquire', tok.wsB, { name: 'merge:x/y' }, { 'x-pmux-session': 'pt-ws-b-pane-1-tab-old' });
      expect(res.body).toMatchObject({ lease: { holder: { workspaceId: 'ws-b', tabId: 'tab-old', tabName: 'legacy', verified: false } } });
    });

    it('refuses a workspace token that names no tab with caller-unresolved', async () => {
      expect(await post('/api/cli/leases/acquire', tok.wsB, { name: 'merge:x/y', ttlSeconds: 60 })).toMatchObject({ status: 403, body: { code: 'caller-unresolved' } });
    });
  });

  describe('list', () => {
    it('lists every lease with holder, epic, note, age, expiry and holder state; filters by prefix and mine', async () => {
      await post('/api/cli/leases/acquire', tok.a, { name: 'merge:x/y', note: 'pba chain' });
      await post('/api/cli/leases/acquire', tok.b, { name: 'epic:p4' });
      await post('/api/cli/leases/acquire', tok.b, { name: 'num:x/y:adr:0373', epic: 'p4' });

      const all = await get('/api/cli/leases', tok.admin);
      expect(all.status).toBe(200);
      const leases = all.body.leases as Array<Record<string, unknown>>;
      expect(leases.map((l) => l.name)).toEqual(['epic:p4', 'merge:x/y', 'num:x/y:adr:0373']);
      expect(leases[1]).toMatchObject({ note: 'pba chain', epic: null, holderState: 'live', expiresInSeconds: expect.any(Number), ageSeconds: expect.any(Number) });
      expect(leases[0]).toMatchObject({ expiresInSeconds: null, holder: { workspaceName: 'Beta', tabName: 'worker B' } });
      expect(leases[2]).toMatchObject({ epic: 'p4', survivesTab: true });

      expect(((await get('/api/cli/leases', tok.b, { mine: '1' })).body.leases as unknown[]).length).toBe(2);
      expect(((await get('/api/cli/leases', tok.b, { prefix: 'merge:' })).body.leases as Array<{ name: string }>).map((l) => l.name)).toEqual(['merge:x/y']);
    });

    it('shows closed for a holder tab that left the layout', async () => {
      await post('/api/cli/leases/acquire', tok.admin, { name: 'smoke:x', ttlSeconds: 60 });
      await post('/api/cli/leases/acquire', tok.a, { name: 'smoke:y' });
      await writeFixture(mockHome.value, [
        { id: 'ws-a', name: 'Alpha', tabs: [{ id: 'tab-o', name: 'orch' }] },
        { id: 'ws-b', name: 'Beta', tabs: [] },
      ]);
      const states = ((await get('/api/cli/leases', tok.admin)).body.leases as Array<{ name: string; holderState: string }>).map((l) => [l.name, l.holderState]);
      expect(states).toEqual([['smoke:x', 'admin'], ['smoke:y', 'closed']]);
    });
  });

  describe('renew, release, break, release-epic', () => {
    it('lets only the holder renew or release, and says who holds it', async () => {
      await post('/api/cli/leases/acquire', tok.a, { name: 'merge:x/y' });
      expect(await post('/api/cli/leases/release', tok.b, { name: 'merge:x/y' })).toMatchObject({ status: 409, body: { code: 'lease-held-by-other', holder: { tabId: 'tab-a' } } });
      expect(await post('/api/cli/leases/renew', tok.b, { name: 'merge:x/y' })).toMatchObject({ status: 409, body: { code: 'lease-held-by-other' } });
      expect(await post('/api/cli/leases/renew', tok.a, { name: 'merge:x/y', ttlSeconds: 1200 })).toMatchObject({ status: 200, body: { lease: { ttlSeconds: 1200 } } });
      expect(await post('/api/cli/leases/release', tok.a, { name: 'merge:x/y' })).toMatchObject({ status: 200, body: { released: true } });
      expect(await post('/api/cli/leases/release', tok.a, { name: 'merge:x/y' })).toMatchObject({ status: 404, body: { code: 'lease-not-found' } });
    });

    it('breaks only with the admin token', async () => {
      await post('/api/cli/leases/acquire', tok.a, { name: 'merge:x/y' });
      expect(await post('/api/cli/leases/break', tok.b, { name: 'merge:x/y', reason: 'stuck' })).toMatchObject({ status: 403, body: { code: 'forbidden' } });
      expect(await post('/api/cli/leases/break', tok.admin, { name: 'merge:x/y', reason: 'stuck' })).toMatchObject({ status: 200, body: { broken: { name: 'merge:x/y' } } });
    });

    it('releases an epic\'s claims for the epic holder and answers [] when none remain', async () => {
      await post('/api/cli/leases/acquire', tok.b, { name: 'epic:p4' });
      await post('/api/cli/leases/acquire', tok.a, { name: 'num:x/y:adr:0373', epic: 'p4' });
      expect(await post('/api/cli/leases/release-epic', tok.b, { epic: 'p4' })).toMatchObject({ status: 200, body: { released: ['num:x/y:adr:0373'] } });
      expect(await post('/api/cli/leases/release-epic', tok.b, { epic: 'p4' })).toMatchObject({ status: 200, body: { released: [] } });
    });
  });

  describe('refusals always carry a machine code', () => {
    it('refuses an unknown token with forbidden', async () => {
      for (const [route, method] of [['/api/cli/leases', 'GET'], ['/api/cli/leases/check', 'GET'], ['/api/cli/leases/acquire', 'POST']] as const) {
        expect(await callRoute(routes[route], { method, headers: { 'x-pmux-token': 'f'.repeat(64) }, query: { name: 'merge:x/y' }, body: { name: 'merge:x/y' } }))
          .toMatchObject({ status: 403, body: { code: 'forbidden' } });
      }
    });

    it('answers 405 for the wrong method', async () => {
      expect((await callRoute(routes['/api/cli/leases/acquire'], { method: 'GET', headers: as(tok.a) })).status).toBe(405);
      expect((await callRoute(routes['/api/cli/leases/check'], { method: 'POST', headers: as(tok.a) })).status).toBe(405);
    });

    it('fails closed with lease-store-unreadable when leases.json is corrupt', async () => {
      await fs.writeFile(path.join(mockHome.value, '.purplemux', 'leases.json'), '{broken');
      expect(await get('/api/cli/leases/check', tok.a, { name: 'merge:x/y' })).toMatchObject({ status: 500, body: { code: 'lease-store-unreadable' } });
      expect(await post('/api/cli/leases/acquire', tok.a, { name: 'merge:x/y' })).toMatchObject({ status: 500, body: { code: 'lease-store-unreadable' } });
    });
  });
});
