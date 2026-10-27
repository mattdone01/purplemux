import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainRouteLocks, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

// The installed CLI against the real flow route, workspace token checks and store.

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

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);
const MIN = 60_000;

interface IResult { code: number; stdout: string; stderr: string }
let cliHome: string;

const cli = async (args: string[], env: Record<string, string>, input?: string): Promise<IResult> => {
  try {
    const child = run(process.execPath, [ENTRY, ...args], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: cliHome, NO_UPDATE_NOTIFIER: '1', ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (input !== undefined) { child.child.stdin?.end(input); } else { child.child.stdin?.end(); }
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (err) {
    const f = err as { code?: number; stdout?: string; stderr?: string };
    return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
  }
};

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, generatedAt: Date.now() - MIN, source: 'v2-flow',
  queues: [
    { name: 'landing', capacity: 20, items: [
      { id: 'lane/a0', label: null, since: Date.now() - 67 * 60 * MIN, state: 'queued', pinned: false, holder: null },
      { id: 'lane/b1', label: null, since: Date.now() - 5 * MIN, state: 'active', pinned: false, holder: 'tab-x' },
    ] },
    { name: 'review', capacity: null, items: [] },
  ],
  locks: [{ name: 'landing', heldBy: 'lane/b1', since: Date.now() - 30 * MIN }, { name: 'deploy', heldBy: null, since: null }],
  meters: [{ name: 'gate-slots', value: 4, unit: 'slots', limit: 5, windowMinutes: 60 }],
  flags: [{ text: 'main is red', severity: 'block' }],
  ...overrides,
});

describe('purplemux flow — the installed CLI against the real route', () => {
  let server: { port: number; close: () => Promise<void> };
  let orchA: Record<string, string>;
  let file: string;
  const flowFile = () => path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-a', 'flow.json');

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    delete (globalThis as Record<string, unknown>).__ptFlowReadCache;
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-flow-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-flow-home-'));
    file = path.join(cliHome, 'snapshot.json');
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }], orchestratorTabId: 'tab-a1' },
      { id: 'ws-b', name: 'beta', tabs: [{ id: 'tab-b1', name: 'orchestrator b' }], orchestratorTabId: 'tab-b1' },
    ]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    const { default: flow } = await import('@/pages/api/cli/workspaces/[workspaceId]/flow');
    const route = (workspaceId: string): typeof flow => (req, res) => {
      req.query = { ...req.query, workspaceId };
      return flow(req, res);
    };
    server = await serveLeaseRoutes({
      '/api/cli/workspaces/ws-a/flow': route('ws-a'),
      '/api/cli/workspaces/ws-b/flow': route('ws-b'),
    });
    orchA = { PMUX_PORT: String(server.port), PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1') };
  });

  afterEach(async () => {
    await server.close();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  it('publishes from @FILE and prints ok, the receive time and the history rows', async () => {
    await fs.writeFile(file, JSON.stringify(snapshot()));
    const first = await cli(['flow', 'publish', '-w', 'ws-a', '--json', `@${file}`], orchA);
    expect(first.code, first.stderr).toBe(0);
    const receivedAt = JSON.parse(await fs.readFile(flowFile(), 'utf-8')).receivedAt;
    expect(first.stdout).toBe(`ok ${receivedAt} 1\n`);
    const second = await cli(['flow', 'publish', '-w', 'ws-a', '--json', `@${file}`], orchA);
    expect(second.stdout).toMatch(/^ok \d+ 2\n$/);
  });

  it('publishes from stdin', async () => {
    const published = await cli(['flow', 'publish', '-w', 'ws-a'], orchA, JSON.stringify(snapshot()));
    expect(published.code, published.stderr).toBe(0);
    expect(published.stdout).toMatch(/^ok \d+ 1\n$/);
  });

  it('exits 2 with the refused field for a snapshot that breaks the contract', async () => {
    await fs.writeFile(file, JSON.stringify(snapshot({ source: '' })));
    const refused = await cli(['flow', 'publish', '-w', 'ws-a', '--json', `@${file}`], orchA);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('flow-invalid');
    expect(refused.stderr).toContain('source: saw "", expected a non-blank string of at most 64 characters');
    await expect(fs.access(flowFile())).rejects.toThrow();
  });

  it('exits 2 flow-too-large for a snapshot over 1 MiB and sends nothing', async () => {
    const item = (id: string) => ({ id, label: 'l'.repeat(120), since: Date.now() - MIN, state: 'queued', pinned: false, holder: 'h'.repeat(128) });
    await fs.writeFile(file, JSON.stringify(snapshot({ queues: Array.from({ length: 20 }, (_, q) => ({ name: `q${q}`, capacity: null,
      items: Array.from({ length: 500 }, (_, index) => item(`${'i'.repeat(100)}-${index}`)) })) })));
    const refused = await cli(['flow', 'publish', '-w', 'ws-a', '--json', `@${file}`], orchA);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/flow-too-large .* saw \d+ bytes, expected at most 1048576/);
    await expect(fs.access(flowFile())).rejects.toThrow();
  });

  it('exits 3 forbidden for a publish into another workspace', async () => {
    await fs.writeFile(file, JSON.stringify(snapshot()));
    const refused = await cli(['flow', 'publish', '-w', 'ws-b', '--json', `@${file}`], orchA);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain('forbidden');
  });

  it('shows queues, locks, meters and producer flags', async () => {
    await cli(['flow', 'publish', '-w', 'ws-a'], orchA, JSON.stringify(snapshot()));
    const shown = await cli(['flow', 'show', '-w', 'ws-a'], orchA);
    expect(shown.code, shown.stderr).toBe(0);
    const lines = shown.stdout.split('\n');
    expect(lines[0]).toMatch(/^flow ws-a {2}source v2-flow {2}generated \S+Z {2}received \S+Z \(\d+s ago\)$/);
    expect(shown.stdout).not.toContain('stale');
    expect(lines, shown.stdout).toContain('queues');
    expect(lines).toContain('  landing  2/20  oldest 2d 19h');
    expect(lines).toContain('  review  0  oldest —');
    expect(lines).toContain('locks');
    expect(lines.some((line) => /^ {2}landing {2}held by lane\/b1 since \S+Z \(30m\) {2}\(busy share unknown: 0 min known in the last 6 h\)$/.test(line)),
      shown.stdout).toBe(true);
    expect(lines).toContain('  deploy  free  (busy share unknown: 0 min known in the last 6 h)');
    expect(lines).toContain('meters');
    expect(lines).toContain('  gate-slots  4 slots  limit 5  window 60m');
    expect(lines).toContain('flags');
    expect(lines).toContain('  block  main is red');
    expect(lines).toContain('derived flags');
    expect(lines).toContain('  warn  queue-old  landing oldest item waits 67 h (threshold 4 h)');
  });

  it('prints the busy share and the derived flags the server derives', async () => {
    const now = Date.now();
    const history = Array.from({ length: 73 }, (_, index) => ({ at: now - (360 - index * 5) * MIN, queues: {}, oldest: {},
      locks: { landing: true, deploy: false }, meters: {} }));
    await fs.writeFile(flowFile(), JSON.stringify({ workspaceId: 'ws-a', receivedAt: now - MIN, snapshot: snapshot(), history }));
    const shown = await cli(['flow', 'show', '-w', 'ws-a'], orchA);
    expect(shown.code, shown.stderr).toBe(0);
    const lines = shown.stdout.split('\n');
    expect(lines.some((line) => /^ {2}landing {2}held by .* {2}\(held 100% of the last 6 h\)$/.test(line)), shown.stdout).toBe(true);
    expect(lines).toContain('  deploy  free  (held 0% of the last 6 h)');
    expect(lines).toContain('  warn  lock-busy  landing held 100% of the last 6 h (threshold 80%)');
    const json = JSON.parse((await cli(['flow', 'show', '-w', 'ws-a', '--json'], orchA)).stdout);
    expect(json.derived).toMatchObject({ lockBusyShare: { landing: 1, deploy: 0 }, windowMinutes: 360 });
  });

  it('says the busy sentence the server and the panel say (parity with lockBusyPhrase)', async () => {
    const { lockBusyPhrase } = await import('@/lib/flow-flags');
    const now = Date.now();
    // 181 of the 360 window minutes known, 57 of them held: the sentence names the known time.
    const history = Array.from({ length: 182 }, (_, index) => ({ at: now - (181 - index) * MIN, queues: {}, oldest: {},
      locks: { landing: index >= 124, deploy: false }, meters: {} }));
    await fs.writeFile(flowFile(), JSON.stringify({ workspaceId: 'ws-a', receivedAt: now - MIN, snapshot: snapshot(), history }));
    const json = JSON.parse((await cli(['flow', 'show', '-w', 'ws-a', '--json'], orchA)).stdout);
    const shown = await cli(['flow', 'show', '-w', 'ws-a'], orchA);
    const { lockBusyShare, lockKnownMinutes, windowMinutes } = json.derived;
    for (const name of ['landing', 'deploy']) {
      const phrase = lockBusyPhrase(lockBusyShare[name], lockKnownMinutes[name], windowMinutes);
      expect(phrase).toMatch(/ of 3 h 1 min known in the last 6 h$/);
      expect(shown.stdout).toContain(`  (${phrase})\n`);
    }
    const thin = history.slice(-60);
    await fs.writeFile(flowFile(), JSON.stringify({ workspaceId: 'ws-a', receivedAt: now - MIN, snapshot: snapshot(), history: thin }));
    const thinJson = JSON.parse((await cli(['flow', 'show', '-w', 'ws-a', '--json'], orchA)).stdout);
    const unknown = lockBusyPhrase(null, thinJson.derived.lockKnownMinutes.landing, 360);
    expect(unknown).toBe('busy share unknown: 59 min known in the last 6 h');
    expect((await cli(['flow', 'show', '-w', 'ws-a'], orchA)).stdout).toContain(`  (${unknown})\n`);
  });

  it('says stale when the record was received more than 10 minutes ago', async () => {
    await fs.writeFile(flowFile(), JSON.stringify({ workspaceId: 'ws-a', receivedAt: Date.now() - 11 * MIN,
      snapshot: snapshot({ queues: [], locks: [], meters: [], flags: [] }), history: [] }));
    const shown = await cli(['flow', 'show', '-w', 'ws-a'], orchA);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toMatch(/\nstale — last published 11m ago\n/);
    expect(shown.stdout).toContain('queues  none\n');
    expect(shown.stdout).toContain('flags  none\n');
    expect(shown.stdout).toContain('derived flags\n  warn  stale  no publish for 11 min\n');
  });

  it('prints the record with --json and honours --history', async () => {
    await cli(['flow', 'publish', '-w', 'ws-a'], orchA, JSON.stringify(snapshot()));
    const all = await cli(['flow', 'show', '-w', 'ws-a', '--json'], orchA);
    expect(all.code, all.stderr).toBe(0);
    expect(JSON.parse(all.stdout)).toMatchObject({ stale: false, flow: { workspaceId: 'ws-a', snapshot: { source: 'v2-flow' } } });
    expect(JSON.parse(all.stdout).flow.history).toHaveLength(1);
    const none = await cli(['flow', 'show', '-w', 'ws-a', '--json', '--history', 'none'], orchA);
    expect(JSON.parse(none.stdout).flow.history).toEqual([]);
    const bad = await cli(['flow', 'show', '-w', 'ws-a', '--history', 'some'], orchA);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--history');
  });

  it('exits 7 flow-not-found when nothing was published', async () => {
    for (const args of [['flow', 'show', '-w', 'ws-a'], ['flow', 'show', '-w', 'ws-a', '--json']]) {
      const shown = await cli(args, orchA);
      expect(shown.code).toBe(7);
      expect(shown.stderr).toContain('flow-not-found');
      expect(shown.stderr).toContain('no flow published');
    }
  });

  it('exits 1 flow-unreadable for a damaged record, and the next publish warns that history restarted', async () => {
    await fs.writeFile(flowFile(), 'not json');
    const shown = await cli(['flow', 'show', '-w', 'ws-a'], orchA);
    expect(shown.code).toBe(1);
    expect(shown.stderr).toContain('flow-unreadable');
    expect(shown.stderr).toContain('the file is not JSON');
    expect(shown.stderr).not.toContain('no flow published');
    const published = await cli(['flow', 'publish', '-w', 'ws-a'], orchA, JSON.stringify(snapshot()));
    expect(published.code, published.stderr).toBe(0);
    expect(published.stdout).toMatch(/^ok \d+ 1\n$/);
    expect(published.stderr).toMatch(/history reset: the stored record did not validate and was moved aside/);
  });

  it('names a usage error', async () => {
    expect((await cli(['flow', 'show'], orchA)).code).toBe(2);
    expect((await cli(['flow', 'drop', '-w', 'ws-a'], orchA)).code).toBe(2);
    const missing = await cli(['flow', 'publish', '-w', 'ws-a', '--json', `@${file}.absent`], orchA);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('cannot read');
    await fs.writeFile(file, '{');
    expect((await cli(['flow', 'publish', '-w', 'ws-a', '--json', `@${file}`], orchA)).stderr).toContain('flow must be valid JSON');
  });
});
