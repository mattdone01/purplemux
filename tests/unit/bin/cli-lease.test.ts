import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainRouteLocks, loadLeaseRoutes, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

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

// The installed entry point: a group missing from bin/cli-commands.js is `unknown command` there.
const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IResult { code: number; stdout: string; stderr: string }

const cli = async (args: string[], env: Record<string, string>): Promise<IResult> => {
  try {
    const { stdout, stderr } = await run(process.execPath, [ENTRY, 'lease', ...args], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: cliHome, NO_UPDATE_NOTIFIER: '1', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const f = err as { code?: number; stdout?: string; stderr?: string };
    return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
  }
};

let cliHome: string;

describe('purplemux lease — the installed CLI against the real lease routes', () => {
  let server: { port: number; close: () => Promise<void> };
  let tabA: Record<string, string>;
  let tabB: Record<string, string>;
  let legacyB: Record<string, string>;

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-lease-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-lease-home-'));
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'Alpha', tabs: [{ id: 'tab-a', name: 'worker A' }] },
      { id: 'ws-b', name: 'Beta', tabs: [{ id: 'tab-b', name: 'worker B' }, { id: 'tab-old', name: 'legacy' }] },
    ]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    const { getWorkspaceToken } = await import('@/lib/workspace-token');
    server = await serveLeaseRoutes(await loadLeaseRoutes());
    const port = String(server.port);
    tabA = { PMUX_PORT: port, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a' }, 'pt-ws-a-pane-1-tab-a') };
    tabB = { PMUX_PORT: port, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-b', tabId: 'tab-b' }, 'pt-ws-b-pane-1-tab-b') };
    // A tab created before the deploy: workspace token only, identified by its tmux session.
    const fakeBin = path.join(cliHome, 'bin');
    await fs.mkdir(fakeBin);
    await fs.writeFile(path.join(fakeBin, 'tmux'), '#!/bin/sh\necho pt-ws-b-pane-1-tab-old\n', { mode: 0o755 });
    legacyB = { PMUX_PORT: port, PMUX_TOKEN: getWorkspaceToken('ws-b'), TMUX: '/tmp/fake,1,0', PATH: `${fakeBin}:${process.env.PATH ?? ''}` };
  });

  afterEach(async () => {
    await server.close();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  it('check: exit 3 with the holder on stdout from another tab, 0 from the holder, 7 for a name nobody holds', async () => {
    expect((await cli(['acquire', 'merge:x/y'], tabA)).code).toBe(0);

    const fromB = await cli(['check', 'merge:x/y'], tabB);
    expect(fromB.code).toBe(3);
    const body = JSON.parse(fromB.stdout);
    expect(body).toMatchObject({ held: true, mine: false, lease: { holder: { workspaceId: 'ws-a', tabId: 'tab-a', tabName: 'worker A' } } });

    const fromA = await cli(['check', 'merge:x/y'], tabA);
    expect(fromA.code).toBe(0);
    expect(JSON.parse(fromA.stdout)).toMatchObject({ held: true, mine: true });

    const prefix = await cli(['check', 'merge:x/y-z'], tabB);
    expect(prefix.code).toBe(7);
    expect(JSON.parse(prefix.stdout)).toEqual({ held: false, mine: false, lease: null });
  });

  it('acquire: exit 3 naming workspace, tab and age while another tab holds it', async () => {
    await cli(['acquire', 'merge:x/y'], tabA);
    const second = await cli(['acquire', 'merge:x/y'], tabB);
    expect(second.code).toBe(3);
    expect(second.stderr).toMatch(/lease-held .*merge:x\/y is held by ws-a\/tab-a \(worker A\) for \d+s/);
  });

  it('acquire: exit 2 for a num claim without --epic (server policy) and for a bad --ttl (never sent)', async () => {
    const noEpic = await cli(['acquire', 'num:x/y:adr:0001'], tabA);
    expect(noEpic.code).toBe(2);
    expect(noEpic.stderr).toContain('num leases require an epic');
    const badTtl = await cli(['acquire', 'merge:x/y', '--ttl', 'soon'], tabA);
    expect(badTtl.code).toBe(2);
    expect(badTtl.stderr).toContain('--ttl must be a duration');
  });

  it('parses --ttl, --epic and --note into the request', async () => {
    const r = await cli(['acquire', 'num:x/y:adr:0002', '--ttl', '3d', '--epic', 'p4', '--note', 'ADR for p4'], tabA);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ outcome: 'acquired', lease: { ttlSeconds: 3 * 86400, epic: 'p4', note: 'ADR for p4' } });
    const none = await cli(['acquire', 'epic:p4', '--ttl', 'none'], tabA);
    expect(JSON.parse(none.stdout)).toMatchObject({ lease: { ttlSeconds: null, expiresAt: null } });
  });

  it('records a pre-token tab as unverified, resolved from its tmux session', async () => {
    const r = await cli(['acquire', 'merge:x/y'], legacyB);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ lease: { holder: { workspaceId: 'ws-b', tabId: 'tab-old', verified: false } } });
  });

  it('release: 0 for the holder, 3 for another tab, 7 when nobody holds it', async () => {
    await cli(['acquire', 'merge:x/y'], tabA);
    expect((await cli(['release', 'merge:x/y'], tabB)).code).toBe(3);
    expect((await cli(['release', 'merge:x/y'], tabA)).code).toBe(0);
    expect((await cli(['release', 'merge:x/y'], tabA)).code).toBe(7);
  });

  it('list: text by default, JSON with --json, filtered by --mine and --prefix', async () => {
    await cli(['acquire', 'merge:x/y', '--note', 'chain'], tabA);
    await cli(['acquire', 'epic:p4'], tabB);

    const text = await cli(['list'], tabA);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^epic:p4 {2}holder=ws-b \(Beta\) \/ tab-b \(worker B\) {2}state=live {2}age=\d+s {2}expires-in=-$/m);
    expect(text.stdout).toMatch(/^merge:x\/y {2}holder=ws-a \(Alpha\) \/ tab-a \(worker A\) .* note="chain"$/m);

    expect(JSON.parse((await cli(['list', '--json', '--mine'], tabB)).stdout).leases.map((l: { name: string }) => l.name)).toEqual(['epic:p4']);
    expect(JSON.parse((await cli(['list', '--prefix', 'merge:', '--json'], tabB)).stdout).leases).toHaveLength(1);
  });

  it('renew and release-epic reach their routes; break needs --reason', async () => {
    await cli(['acquire', 'merge:x/y'], tabA);
    expect(JSON.parse((await cli(['renew', 'merge:x/y', '--ttl', '2h'], tabA)).stdout)).toMatchObject({ lease: { ttlSeconds: 7200 } });
    await cli(['acquire', 'epic:p4'], tabB);
    await cli(['acquire', 'num:x/y:adr:0009', '--epic', 'p4'], tabA);
    expect(JSON.parse((await cli(['release-epic', 'p4'], tabB)).stdout)).toEqual({ released: ['num:x/y:adr:0009'] });
    expect((await cli(['break', 'merge:x/y'], tabA)).code).toBe(2);
    expect((await cli(['break', 'merge:x/y', '--reason', 'stuck'], tabB)).code).toBe(3);
  });
});

describe('purplemux lease — without a lease-capable server', () => {
  let stub: http.Server;
  let stubPort: number;

  beforeAll(async () => {
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-lease-home-'));
    // A server that predates leases: the framework's HTML not-found page for every lease route.
    stub = http.createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><title>404</title>');
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubPort = (stub.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  const everyCommand = [
    ['acquire', 'merge:x/y'], ['renew', 'merge:x/y'], ['release', 'merge:x/y'], ['list'], ['check', 'merge:x/y'],
    ['break', 'merge:x/y', '--reason', 'r'], ['release-epic', 'p4'],
  ];

  it.each(everyCommand)('exits 6 with no server: lease %s', async (...args) => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const r = await cli(args, { PMUX_PORT: String(port), PMUX_TOKEN: 't' });
    expect(r.code).toBe(6);
    expect(r.stderr).toContain('server-unreachable');
  });

  it.each(everyCommand)('exits 6 with routes-absent against a server that predates leases: lease %s', async (...args) => {
    const r = await cli(args, { PMUX_PORT: String(stubPort), PMUX_TOKEN: 't' });
    expect(r.code).toBe(6);
    expect(r.stderr).toMatch(/^error: routes-absent \(no such route on this server/m);
  });

  it('dispatches through the installed entry point, never "unknown command"', async () => {
    const r = await cli(['list'], { PMUX_PORT: String(stubPort), PMUX_TOKEN: 't' });
    expect(r.stderr).not.toContain('unknown command');
  });

  it('prints usage and exits 2 for an unknown subcommand or a missing name', async () => {
    expect((await cli(['frobnicate'], { PMUX_PORT: String(stubPort), PMUX_TOKEN: 't' })).code).toBe(2);
    expect((await cli(['check'], { PMUX_PORT: String(stubPort), PMUX_TOKEN: 't' })).code).toBe(2);
    expect((await cli(['list', 'extra'], { PMUX_PORT: String(stubPort), PMUX_TOKEN: 't' })).code).toBe(2);
  });
});
