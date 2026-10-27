import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, drainRouteLocks, resetRouteGlobals, writeFixture } from './leases-harness';

// Both flow routes against the real store, the real workspace token checks and a signed session.

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/tmux', () => ({
  hasSession: vi.fn(async () => true),
  listSessions: vi.fn(async () => []),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

const MIN = 60_000;

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, generatedAt: Date.now() - MIN, source: 'v2-flow',
  queues: [{ name: 'landing', capacity: 20, items: [
    { id: 'lane/a0', label: 'A0', since: Date.now() - 67 * 60 * MIN, state: 'queued', pinned: false, holder: null },
  ] }],
  locks: [{ name: 'landing', heldBy: 'lane/a0', since: Date.now() - 30 * MIN }],
  meters: [{ name: 'gate-slots', value: 4, unit: 'slots', limit: 5, windowMinutes: null }],
  flags: [{ text: 'main is red', severity: 'block' }, { text: 'two reviews wait', severity: 'info' }],
  ...overrides,
});

const row = (at: number) => ({ at, queues: { landing: 1 }, oldest: { landing: at - MIN }, locks: { landing: true }, meters: { 'gate-slots': 4 } });

const wsDir = (wsId: string) => path.join(mockHome.value, '.purplemux', 'workspaces', wsId);
const flowFile = (wsId: string) => path.join(wsDir(wsId), 'flow.json');

describe('flow routes', () => {
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let admin: string;
  let cookie: string;
  type THandler = Parameters<typeof callRoute>[0];
  let cliRoute: THandler;
  let missionRoute: THandler;

  const cli = (method: string, workspaceId: string, token: string, init: { body?: unknown; query?: Record<string, string> } = {}) =>
    callRoute(cliRoute, { method, headers: { 'x-pmux-token': token }, query: { workspaceId, ...init.query }, body: init.body });
  const mission = (query: Record<string, string> = {}, headers: Record<string, string> = { cookie: `session-token=${cookie}` }, method = 'GET') =>
    callRoute(missionRoute, { method, headers, query });

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    delete (globalThis as Record<string, unknown>).__ptFlowReadCache;
    delete (globalThis as Record<string, unknown>).__ptFlowLocks;
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-flow-routes-'));
    process.env.NEXTAUTH_SECRET = 'flow-route-test-secret-at-least-32-bytes';
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }], orchestratorTabId: 'tab-a1' },
      { id: 'ws-b', name: 'beta', tabs: [{ id: 'tab-b1', name: 'orchestrator b' }], orchestratorTabId: 'tab-b1' },
      { id: 'ws-c', name: 'gamma', tabs: [{ id: 'tab-c1', name: 'orchestrator c' }], orchestratorTabId: 'tab-c1' },
    ]);
    const workspacesFile = path.join(mockHome.value, '.purplemux', 'workspaces.json');
    const data = JSON.parse(await fs.readFile(workspacesFile, 'utf-8'));
    data.workspaces[1].allowedPeers = ['ws-a'];
    await fs.writeFile(workspacesFile, JSON.stringify(data));
    const { ensureTabToken } = await import('@/lib/tab-token');
    tokenA = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1');
    tokenB = await ensureTabToken({ workspaceId: 'ws-b', tabId: 'tab-b1' }, 'pt-ws-b-pane-1-tab-b1');
    tokenC = await ensureTabToken({ workspaceId: 'ws-c', tabId: 'tab-c1' }, 'pt-ws-c-pane-1-tab-c1');
    delete (globalThis as Record<string, unknown>).__ptGrants;
    admin = (await import('@/lib/cli-token')).getCliToken();
    cookie = await (await import('@/lib/auth')).signSessionToken();
    cliRoute = (await import('@/pages/api/cli/workspaces/[workspaceId]/flow')).default as THandler;
    missionRoute = (await import('@/pages/api/mission-control/flow')).default as THandler;
  });

  afterEach(async () => {
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  describe('POST and GET /api/cli/workspaces/{ws}/flow', () => {
    it('answers no flow before the first publish', async () => {
      const read = await cli('GET', 'ws-a', tokenA);
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ flow: null, stale: null });
      expect(read.headers['Cache-Control']).toBe('no-store');
    });

    it('publishes a snapshot, appends one history row and serves it back', async () => {
      const body = snapshot();
      const published = await cli('POST', 'ws-a', tokenA, { body });
      expect(published.status).toBe(200);
      expect(published.headers['Cache-Control']).toBe('no-store');
      const stored = await fs.readFile(flowFile('ws-a'), 'utf-8');
      const receivedAt = JSON.parse(stored).receivedAt as number;
      expect(published.body).toEqual({ ok: true, workspaceId: 'ws-a', receivedAt, generatedAt: body.generatedAt,
        historyRows: 1, historyReset: false, bytes: Buffer.byteLength(stored) });
      await cli('POST', 'ws-a', tokenA, { body });
      const read = await cli('GET', 'ws-a', tokenA);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ stale: false, flow: { workspaceId: 'ws-a', snapshot: body } });
      expect((read.body.flow as { history: unknown[] }).history).toHaveLength(2);
      expect((read.body.flow as { history: unknown[] }).history[0]).toEqual({ at: receivedAt, queues: { landing: 1 },
        oldest: { landing: body.queues[0].items[0].since }, locks: { landing: true }, meters: { 'gate-slots': 4 } });
    });

    it('refuses a snapshot that breaks the contract, naming the field, and stores nothing', async () => {
      await cli('POST', 'ws-a', tokenA, { body: snapshot() });
      const before = await fs.readFile(flowFile('ws-a'), 'utf-8');
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [snapshot({ queues: [{ name: 'landing', capacity: null, items: [{ ...snapshot().queues[0].items[0], state: 'parked' }] }] }),
          /^Invalid flow: queues\[0\]\.items\[0\]\.state: saw "parked", expected one of queued, active, held$/],
        [snapshot({ queues: Array.from({ length: 21 }, (_, index) => ({ name: `q${index}`, capacity: null, items: [] })) }),
          /^Invalid flow: queues: saw 21 entries, expected at most 20$/],
        [snapshot({ queues: [{ name: 'q', capacity: null, items: Array.from({ length: 501 }, (_, index) => ({ ...snapshot().queues[0].items[0], id: `i${index}` })) }] }),
          /^Invalid flow: queues\[0\]\.items: saw 501 entries, expected at most 500$/],
        [snapshot({ generatedAt: Date.now() + 6 * MIN }), /^Invalid flow: generatedAt: saw \d+, expected a time in Unix ms at most 5 min after/],
        [snapshot({ queues: [{ name: 'q', capacity: null, items: [] }, { name: 'q', capacity: null, items: [] }] }),
          /^Invalid flow: queues\[1\]\.name: saw "q", expected a name no other queue holds$/],
        [snapshot({ queues: [{ name: 'q', capacity: null, items: [{ ...snapshot().queues[0].items[0], id: 'x'.repeat(129) }] }] }),
          /^Invalid flow: queues\[0\]\.items\[0\]\.id: saw "x+…, expected a non-blank string of at most 128 characters$/],
        [{ ...snapshot(), history: [] }, /^Invalid flow: history: saw an unknown key/],
      ];
      for (const [body, message] of cases) {
        const refused = await cli('POST', 'ws-a', tokenA, { body });
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe('flow-invalid');
        expect(refused.body.error).toMatch(message);
      }
      expect(await fs.readFile(flowFile('ws-a'), 'utf-8')).toBe(before);
    });

    it('refuses a snapshot over 1 MiB with flow-too-large and stores nothing', async () => {
      const item = (id: string) => ({ id, label: 'l'.repeat(120), since: Date.now() - MIN, state: 'queued', pinned: false, holder: 'h'.repeat(128) });
      const body = snapshot({ queues: Array.from({ length: 20 }, (_, q) => ({ name: `q${q}`, capacity: null,
        items: Array.from({ length: 200 }, (_, index) => item(`${'i'.repeat(100)}-${index}`)) })) });
      expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(1024 * 1024);
      const refused = await cli('POST', 'ws-a', tokenA, { body });
      expect(refused.status).toBe(413);
      expect(refused.body.code).toBe('flow-too-large');
      expect(refused.body.error).toMatch(/^Flow too large: saw \d+ bytes, expected at most 1048576$/);
      await expect(fs.access(flowFile('ws-a'))).rejects.toThrow();
    });

    it('confines a publish to the own workspace, whatever peer or admin token the caller holds', async () => {
      expect((await cli('POST', 'ws-b', tokenA, { body: snapshot() })).body).toMatchObject({ code: 'forbidden' });
      expect((await cli('POST', 'ws-b', tokenA, { body: snapshot() })).status).toBe(403);
      expect((await cli('POST', 'ws-a', admin, { body: snapshot() })).status).toBe(403);
      expect((await cli('POST', 'ws-a', 'not-a-token', { body: snapshot() })).status).toBe(403);
      await expect(fs.access(flowFile('ws-b'))).rejects.toThrow();
      await expect(fs.access(flowFile('ws-a'))).rejects.toThrow();
    });

    it('serves reads to the own token, a peer and the admin token, and refuses the rest', async () => {
      await cli('POST', 'ws-b', tokenB, { body: snapshot() });
      for (const token of [tokenB, tokenA, admin]) {
        const read = await cli('GET', 'ws-b', token);
        expect(read.status).toBe(200);
        expect(read.body.flow).toMatchObject({ workspaceId: 'ws-b' });
      }
      const foreign = await cli('GET', 'ws-a', tokenB);
      expect(foreign.status).toBe(403);
      expect(foreign.body.code).toBe('forbidden');
    });

    it('serves a read to a drive-grant holder and still refuses its publish', async () => {
      await cli('POST', 'ws-a', tokenA, { body: snapshot() });
      expect((await cli('GET', 'ws-a', tokenC)).status).toBe(403);
      const { createGrantInState, mutateGrants } = await import('@/lib/grant-store');
      await mutateGrants((state) => ({ value: null, state: createGrantInState(state, { granteeWorkspaceId: 'ws-c', granteeTabId: 'tab-c1',
        workspaces: ['ws-a'], reason: 'flow read', expiresInHours: 1, createdBy: 'human' }, Date.now(), 'g-flow1').state }));
      const read = await cli('GET', 'ws-a', tokenC);
      expect(read.status).toBe(200);
      expect(read.body.flow).toMatchObject({ workspaceId: 'ws-a' });
      const publish = await cli('POST', 'ws-a', tokenC, { body: snapshot() });
      expect(publish.status).toBe(403);
      expect(publish.body.code).toBe('forbidden');
    });

    it('refuses a session cookie with no CLI token, as every CLI route does', async () => {
      for (const method of ['GET', 'POST']) {
        const refused = await callRoute(cliRoute, { method, headers: { cookie: `session-token=${cookie}` }, query: { workspaceId: 'ws-a' }, body: snapshot() });
        expect(refused.status).toBe(403);
        expect(refused.body).toEqual({ error: 'Forbidden', code: 'forbidden' });
      }
      await expect(fs.access(flowFile('ws-a'))).rejects.toThrow();
    });

    it('answers flow-write-failed for a publish the store cannot write, and keeps the previous record', async () => {
      await cli('POST', 'ws-a', tokenA, { body: snapshot() });
      const before = await fs.readFile(flowFile('ws-a'), 'utf-8');
      await fs.mkdir(path.join(`${flowFile('ws-a')}.tmp`, 'blocker'), { recursive: true });
      const failed = await cli('POST', 'ws-a', tokenA, { body: snapshot({ source: 'next' }) });
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ error: 'flow storage write failed (write): EISDIR', code: 'flow-write-failed' });
      expect(await fs.readFile(flowFile('ws-a'), 'utf-8')).toBe(before);
      expect((await cli('GET', 'ws-a', tokenA)).body.flow).toMatchObject({ snapshot: { source: 'v2-flow' } });
    });

    it('answers not-found for an unknown workspace and 405 for another method', async () => {
      const gone = await cli('GET', 'ws-gone', admin);
      expect(gone.status).toBe(404);
      expect(gone.body).toEqual({ error: 'Workspace not found', code: 'not-found' });
      const other = await cli('DELETE', 'ws-a', tokenA);
      expect(other.status).toBe(405);
      expect(other.headers.Allow).toBe('GET, POST');
    });

    it('serves all, the window or no history rows', async () => {
      const now = Date.now();
      await fs.writeFile(flowFile('ws-a'), JSON.stringify({ workspaceId: 'ws-a', receivedAt: now - MIN, snapshot: snapshot(),
        history: [row(now - 400 * MIN), row(now - 300 * MIN), row(now - MIN)] }));
      const rows = async (query: Record<string, string>) =>
        ((await cli('GET', 'ws-a', tokenA, { query })).body.flow as { history: Array<{ at: number }> }).history.map((entry) => entry.at);
      expect(await rows({})).toEqual([now - 400 * MIN, now - 300 * MIN, now - MIN]);
      expect(await rows({ history: 'all' })).toHaveLength(3);
      expect(await rows({ history: 'window' })).toEqual([now - 300 * MIN, now - MIN]);
      expect(await rows({ history: 'none' })).toEqual([]);
      const bad = await cli('GET', 'ws-a', tokenA, { query: { history: 'some' } });
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ error: 'history: saw "some", expected all, window or none', code: 'invalid-request' });
    });

    it('reads a record received more than 10 minutes ago as stale', async () => {
      await fs.writeFile(flowFile('ws-a'), JSON.stringify({ workspaceId: 'ws-a', receivedAt: Date.now() - 11 * MIN, snapshot: snapshot(), history: [] }));
      expect((await cli('GET', 'ws-a', tokenA)).body.stale).toBe(true);
    });

    it('answers flow-unreadable for a damaged file, then the next publish moves it aside', async () => {
      await fs.writeFile(flowFile('ws-a'), JSON.stringify({ workspaceId: 'ws-a', receivedAt: 1, snapshot: { schemaVersion: 2 }, history: [] }));
      const read = await cli('GET', 'ws-a', tokenA);
      expect(read.status).toBe(500);
      expect(read.body).toEqual({ error: 'flow storage unreadable: snapshot.schemaVersion: saw 2, expected 1', code: 'flow-unreadable' });
      const published = await cli('POST', 'ws-a', tokenA, { body: snapshot() });
      expect(published.status).toBe(200);
      expect(published.body).toMatchObject({ historyReset: true, historyRows: 1 });
      const aside = (await fs.readdir(wsDir('ws-a'))).filter((name) => name.startsWith('flow.json.corrupt-'));
      expect(aside).toEqual([`flow.json.corrupt-${published.body.receivedAt}`]);
      expect((await cli('GET', 'ws-a', tokenA)).status).toBe(200);
    });
  });

  describe('GET /api/mission-control/flow', () => {
    it('refuses a missing session and a CLI token on both forms', async () => {
      for (const query of [{}, { workspaceId: 'ws-a' }] as Array<Record<string, string>>) {
        expect((await mission(query, {})).status).toBe(401);
        expect((await mission(query, { 'x-pmux-token': admin })).status).toBe(401);
        expect((await mission(query, { 'x-pmux-token': tokenA })).status).toBe(401);
        expect((await mission(query, { cookie: 'session-token=forged' })).status).toBe(401);
      }
    });

    it('lists every workspace with a record, without a derived count before story 02', async () => {
      const empty = await mission();
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ workspaces: [], errors: [] });
      expect(empty.headers['Cache-Control']).toBe('no-store');
      const long = snapshot({ queues: [{ name: 'landing', capacity: null, items: Array.from({ length: 12 }, (_, index) =>
        ({ ...snapshot().queues[0].items[0], id: `lane-${index}` })) }] });
      const publishedA = await cli('POST', 'ws-a', tokenA, { body: long });
      await fs.writeFile(flowFile('ws-b'), JSON.stringify({ workspaceId: 'ws-b', receivedAt: Date.now() - 11 * MIN,
        snapshot: snapshot({ flags: [] }), history: [] }));
      const list = await mission();
      expect(list.status).toBe(200);
      const rows = list.body.workspaces as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        { workspaceId: 'ws-a', workspaceName: 'alpha', receivedAt: publishedA.body.receivedAt, generatedAt: long.generatedAt,
          source: 'v2-flow', stale: false, producerFlagCount: 2 },
        expect.objectContaining({ workspaceId: 'ws-b', workspaceName: 'beta', stale: true, producerFlagCount: 0 }),
      ]);
      for (const entry of rows) expect(Object.hasOwn(entry, 'derivedFlagCount')).toBe(false);
      expect(list.body.errors).toEqual([]);
    });

    it('puts one unreadable record in errors without blanking the list', async () => {
      await cli('POST', 'ws-a', tokenA, { body: snapshot() });
      await fs.writeFile(flowFile('ws-b'), 'not json');
      const list = await mission();
      expect(list.status).toBe(200);
      expect((list.body.workspaces as Array<{ workspaceId: string }>).map((entry) => entry.workspaceId)).toEqual(['ws-a']);
      expect(list.body.errors).toEqual([{ workspaceId: 'ws-b', error: 'flow storage unreadable: the file is not JSON' }]);
    });

    it('serves one workspace record with the window rows by default', async () => {
      expect((await mission({ workspaceId: 'ws-a' })).body).toEqual({ workspaceId: 'ws-a', flow: null, stale: null });
      const now = Date.now();
      await fs.writeFile(flowFile('ws-a'), JSON.stringify({ workspaceId: 'ws-a', receivedAt: now - MIN, snapshot: snapshot(),
        history: [row(now - 400 * MIN), row(now - MIN)] }));
      const detail = await mission({ workspaceId: 'ws-a' });
      expect(detail.status).toBe(200);
      expect(detail.headers['Cache-Control']).toBe('no-store');
      expect(detail.body).toMatchObject({ workspaceId: 'ws-a', stale: false, flow: { workspaceId: 'ws-a', history: [row(now - MIN)] } });
      expect(((await mission({ workspaceId: 'ws-a', history: 'none' })).body.flow as { history: unknown[] }).history).toEqual([]);
      expect(((await mission({ workspaceId: 'ws-a', history: 'all' })).body.flow as { history: unknown[] }).history).toHaveLength(2);
      const bad = await mission({ workspaceId: 'ws-a', history: 'every' });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('invalid-request');
    });

    it('answers storage-unavailable for a damaged record and not-found for an unknown workspace', async () => {
      await fs.writeFile(flowFile('ws-a'), 'not json');
      const damaged = await mission({ workspaceId: 'ws-a' });
      expect(damaged.status).toBe(503);
      expect(damaged.body).toEqual({ error: 'flow storage unreadable: the file is not JSON', code: 'storage-unavailable' });
      const gone = await mission({ workspaceId: '../ws-a' });
      expect(gone.status).toBe(404);
      expect(gone.body.code).toBe('not-found');
    });

    it('refuses writes', async () => {
      const write = await mission({}, { cookie: `session-token=${cookie}` }, 'POST');
      expect(write.status).toBe(405);
      expect(write.headers.Allow).toBe('GET');
    });
  });
});
