import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainRouteLocks, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';
import type { ILayoutData, ITab } from '@/types/terminal';

// ADR-0027 end to end: the installed CLI (`bin/purplemux.js`) against the real
// tab create, tab-count and fleet-config routes, in a temp HOME.

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
  createSession: vi.fn(async () => {}),
  hasSession: vi.fn(async () => true),
  killSession: vi.fn(async () => {}),
  listSessions: vi.fn(async () => []),
  sendKeys: vi.fn(async () => {}),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ registerTab: vi.fn(), markAgentLaunch: vi.fn(), getAllForClient: () => ({}) }),
}));
vi.mock('@/lib/agent-availability', () => ({ checkAgentAvailabilityForPanelType: vi.fn(async () => ({ ok: true })), toAgentAvailabilityError: vi.fn() }));
vi.mock('@/lib/agent-dispatch-policy', () => ({ checkAgentDispatchPolicy: vi.fn(async () => ({ ok: true })) }));

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IResult { code: number; stdout: string; stderr: string }

let cliHome: string;

const cli = async (args: string[], env: Record<string, string>): Promise<IResult> => {
  try {
    const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: cliHome, NO_UPDATE_NOTIFIER: '1', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const f = err as { code?: number; stdout?: string; stderr?: string };
    return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
  }
};

const agentTab = (id: string, order: number): ITab =>
  ({ id, name: id, order, sessionName: `pt-ws-a-pane-1-${id}`, panelType: 'claude-code' });

/** ws-a holds the orchestrator tab-o, the worker tab-w and `extra` more agent tabs, plus one terminal. */
const writeLayout = async (extra: number) => {
  const tabs = ['tab-o', 'tab-w', ...Array.from({ length: extra }, (_, i) => `tab-x${i}`)].map(agentTab);
  tabs.push({ id: 'tab-t', name: 'shell', order: tabs.length, sessionName: 'pt-ws-a-pane-1-tab-t', panelType: 'terminal' });
  const layout: ILayoutData = { root: { type: 'pane', id: 'pane-1', activeTabId: 'tab-o', tabs }, activePaneId: 'pane-1', updatedAt: '2026-10-26T00:00:00.000Z' };
  await fs.writeFile(path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-a', 'layout.json'), JSON.stringify(layout));
};

// Each case spawns the CLI several times; the installed-CLI files allow for a loaded host.
describe('purplemux tab count and the WIP cap — the installed CLI against the real routes (ADR-0027)', { timeout: 60_000 }, () => {
  let server: { port: number; close: () => Promise<void> };
  let orch: Record<string, string>;
  let worker: Record<string, string>;
  let other: Record<string, string>;
  let admin: Record<string, string>;

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    const g = globalThis as Record<string, unknown>;
    delete g.__ptFleetConfigLock;
    delete g.__ptTabCapLogged;
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-tab-count-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-tab-count-home-'));
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-o', name: 'orchestrator' }], orchestratorTabId: 'tab-o' },
      { id: 'ws-b', name: 'beta', tabs: [{ id: 'tab-b', name: 'b' }] },
    ]);
    await writeLayout(0);
    const { ensureTabToken } = await import('@/lib/tab-token');
    const { getCliToken } = await import('@/lib/cli-token');
    const tabCount = (await import('@/pages/api/cli/workspaces/[workspaceId]/tab-count')).default;
    server = await serveLeaseRoutes({
      '/api/cli/tabs': (await import('@/pages/api/cli/tabs/index')).default,
      '/api/cli/workspaces/ws-a/tab-count': (req, res) => { req.query.workspaceId = 'ws-a'; return tabCount(req, res); },
      '/api/cli/workspaces/ws-b/tab-count': (req, res) => { req.query.workspaceId = 'ws-b'; return tabCount(req, res); },
      '/api/cli/fleet-config/tabs.cap-per-workspace': async (req, res) => {
        req.query.key = 'tabs.cap-per-workspace';
        return (await import('@/pages/api/cli/fleet-config/[key]')).default(req, res);
      },
    });
    const port = String(server.port);
    orch = { PMUX_PORT: port, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-o' }, 'pt-ws-a-pane-1-tab-o') };
    worker = { PMUX_PORT: port, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-w' }, 'pt-ws-a-pane-1-tab-w') };
    other = { PMUX_PORT: port, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-b', tabId: 'tab-b' }, 'pt-ws-b-pane-1-tab-b') };
    admin = { PMUX_PORT: port, PMUX_TOKEN: getCliToken() };
  });

  afterEach(async () => {
    await server.close();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  it('tab count prints "<count> <cap>" and --json the whole answer; terminals do not count', async () => {
    await writeLayout(3);
    const plain = await cli(['tab', 'count', '-w', 'ws-a'], worker);
    expect(plain).toEqual({ code: 0, stdout: '5 8\n', stderr: '' });
    const json = await cli(['tab', 'count', '-w', 'ws-a', '--json'], worker);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ workspaceId: 'ws-a', count: 5, cap: 8, capSource: 'default', overCap: false });
  });

  it('tab count needs -w (exit 2) and read scope on WS (exit 3)', async () => {
    expect((await cli(['tab', 'count'], worker)).code).toBe(2);
    const refused = await cli(['tab', 'count', '-w', 'ws-a'], other);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain('forbidden');
  });

  it('tabs.cap-per-workspace is the admin token\'s only; tab count reads the value the admin set (ADR-0027 R2)', async () => {
    const byOrch = await cli(['config', 'set', 'tabs.cap-per-workspace', '20'], orch);
    expect(byOrch.code).toBe(3);
    expect(byOrch.stderr).toContain('admin token only');
    expect((await cli(['config', 'set', 'tabs.cap-per-workspace', '2'], admin)).code).toBe(0);
    expect(JSON.parse((await cli(['tab', 'count', '-w', 'ws-a', '--json'], worker)).stdout))
      .toMatchObject({ count: 2, cap: 2, capSource: 'fleet-config', overCap: false });
  });

  it('a create at the cap exits 3 and names the count and the cap', async () => {
    await writeLayout(6);
    const refused = await cli(['tab', 'create', '-w', 'ws-a', '-t', 'claude-code', '--no-launch'], worker);
    expect(refused.code).toBe(3);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toBe(
      "error: wip-cap (refused by state — close an agent tab first; only the workspace's orchestrator may pass --over-cap --reason) — ws-a holds 8 of 8 agent tabs\n",
    );
    expect((await cli(['tab', 'count', '-w', 'ws-a'], worker)).stdout).toBe('8 8\n');
  });

  it('the orchestrator passes the cap with --over-cap --reason; the answer carries wip.overCap', async () => {
    await writeLayout(6);
    const created = await cli(['tab', 'create', '-w', 'ws-a', '-t', 'claude-code', '--no-launch', '--over-cap', '--reason', 'release blocker'], orch);
    expect(created.code, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout).wip).toEqual({ count: 9, cap: 8, overCap: true });
    expect((await cli(['tab', 'count', '-w', 'ws-a', '--json'], worker)).stdout).toContain('"overCap": true');
  });

  it('a worker passing --over-cap exits 3 forbidden, and nothing is created', async () => {
    await writeLayout(6);
    const refused = await cli(['tab', 'create', '-w', 'ws-a', '-t', 'claude-code', '--no-launch', '--over-cap', '--reason', 'r'], worker);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain('error: forbidden');
    expect((await cli(['tab', 'count', '-w', 'ws-a'], worker)).stdout).toBe('8 8\n');
  });

  it.each([
    ['--over-cap without --reason', ['--over-cap']],
    ['--reason without --over-cap', ['--reason', 'r']],
    ['an empty reason', ['--over-cap', '--reason', '']],
    ['a reason over 500 characters', ['--over-cap', '--reason', 'x'.repeat(501)]],
  ])('%s exits 2 before anything is sent', async (_label, flags) => {
    const r = await cli(['tab', 'create', '-w', 'ws-a', '-t', 'claude-code', '--no-launch', ...flags], orch);
    expect(r.code).toBe(2);
    expect((await cli(['tab', 'count', '-w', 'ws-a'], worker)).stdout).toBe('2 8\n');
  });

  it('an unreadable fleet config exits 3 config-store-unreadable for an agent create and for tab count', async () => {
    await fs.writeFile(path.join(mockHome.value, '.purplemux', 'fleet-config.json'), '{"values":');
    const create = await cli(['tab', 'create', '-w', 'ws-a', '-t', 'claude-code', '--no-launch'], worker);
    expect(create.code).toBe(3);
    expect(create.stderr).toContain('config-store-unreadable');
    const count = await cli(['tab', 'count', '-w', 'ws-a'], worker);
    expect(count.code).toBe(3);
    expect(count.stdout).toBe('');
  });
});
