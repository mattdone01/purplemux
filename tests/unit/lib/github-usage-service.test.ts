import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/fleet-config-store', () => ({
  readFleetConfig: async () => ({ values: {}, versions: {}, history: [] }),
  valueOf: (_state: unknown, key: string) => (key === 'github.agentAccounts' ? { value: 'agent-1' } : null),
}));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaces: async () => ({ workspaces: [{ id: 'ws-1', name: 'epic-a' }] }) }));
vi.mock('@/lib/layout-store', () => ({
  resolveLayoutFile: (id: string) => `/layouts/${id}.json`,
  readLayoutFile: async () => ({ root: {} }),
  collectAllTabs: () => [{ id: 'tab-a', name: 'worker-1' }],
}));

const { getGithubUsageView, runGithubQuotaTick, startGithubUsage, stopGithubUsage } = await import('@/lib/github-usage-service');
const { ghShimDir, installedGhShimDir } = await import('@/lib/gh-shim');
const { serverGhLedger, HOUR_MS } = await import('@/lib/github-usage-ledger');
type IQuotaAlertDeps = import('@/lib/github-quota-alert').IQuotaAlertDeps;

// The runtime: the shim at start, the 5-minute quota read through the real gh, and the view.

let bin = '';
let argvLog = '';
const savedPath = process.env.PATH;

beforeAll(async () => {
  bin = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-fake-gh-'));
  argvLog = path.join(bin, 'argv.log');
  // A fake gh: two accounts, a token per login, and rate_limit answered only with the agent's token in GH_TOKEN.
  await fs.writeFile(path.join(bin, 'gh'), `#!/bin/sh
echo "$* GH_TOKEN=\${GH_TOKEN-unset}" >> '${argvLog}'
case "$1 $2" in
  "auth status") echo "  ✓ Logged in to github.com account agent-1 (keyring)" >&2; echo "  ✓ Logged in to github.com account owner-1 (keyring)" >&2 ;;
  "auth token") echo "tok-$4" ;;
  "api rate_limit")
    [ "$GH_TOKEN" = tok-agent-1 ] || { echo "HTTP 401" >&2; exit 1; }
    echo '{"resources":{"core":{"limit":5000,"remaining":700,"reset":${Math.floor(Date.now() / 1000) + 1800}},"graphql":{"limit":5000,"remaining":5000,"reset":${Math.floor(Date.now() / 1000) + 1800}}}}' ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  process.env.PATH = `${ghShimDir()}:${bin}:${savedPath ?? ''}`;
  process.env.GH_TOKEN = 'server-env-token';
});

afterAll(async () => {
  await stopGithubUsage();
  process.env.PATH = savedPath;
  delete process.env.GH_TOKEN;
  await fs.rm(bin, { recursive: true, force: true });
});

describe('github usage runtime', () => {
  it('installs the shim at start and drops the shim directory from the server PATH', async () => {
    await startGithubUsage();
    expect(installedGhShimDir()).toBe(ghShimDir());
    expect(process.env.PATH?.split(':')).not.toContain(ghShimDir());
    expect(process.env.PATH?.split(':')[0]).toBe(bin);
    const shim = await fs.readFile(path.join(ghShimDir(), 'gh'), 'utf-8');
    expect(shim).toContain(`'${path.join(bin, 'gh')}'`);
  });

  it('reads the agent quota through gh, never asks for the owner token, and alerts the seat once', async () => {
    const routed: string[] = [];
    const alerts: IQuotaAlertDeps = {
      scrumMaster: async () => ({ managerWorkspaceId: 'ws-sm', managerTabId: 'tab-sm', workspaceIds: [] }),
      workspaces: async () => [{ id: 'ws-sm', orchestration: { enabled: true, orchestratorTabId: 'tab-sm' } } as never],
      routeTabEvent: async (event) => { routed.push(event.text); },
      topOwners: async () => [{ label: 'worker-1 (epic-a)', rest: 12 }],
      countedRestSince: async () => 12,
    };
    await runGithubQuotaTick(undefined, alerts);
    await runGithubQuotaTick(undefined, alerts);
    const argv = (await fs.readFile(argvLog, 'utf-8')).trim().split('\n');
    expect(argv.filter((l) => l.startsWith('auth token'))).toEqual(['auth token --user agent-1 GH_TOKEN=unset', 'auth token --user agent-1 GH_TOKEN=unset']);
    expect(argv.some((l) => l.includes('owner-1') && l.startsWith('auth token'))).toBe(false);
    expect(argv.filter((l) => l.startsWith('api rate_limit'))).toEqual(['api rate_limit GH_TOKEN=tok-agent-1', 'api rate_limit GH_TOKEN=tok-agent-1']);
    expect(argv.filter((l) => l.startsWith('auth status'))).toEqual(['auth status GH_TOKEN=unset']);
    expect(routed).toHaveLength(1);
    expect(routed[0]).toContain('GitHub REST quota low: agent-1 core 700/5000 (14%)');
    const view = await getGithubUsageView();
    expect(view.accounts.map((a) => [a.login, a.role, a.state])).toEqual([['agent-1', 'agent', 'read'], ['owner-1', 'owner', 'not-read']]);
    expect(JSON.stringify(view)).not.toContain('tok-');
    expect(view.tabLog.shimInstalled).toBe(true);
    const server = view.windows[0].owners.filter((o) => o.source === 'server' && o.tabId === '-');
    expect(server.reduce((n, o) => n + o.total, 0)).toBeGreaterThanOrEqual(5);
  });

  it('names a watch owner from the layout', async () => {
    serverGhLedger().record({ workspaceId: 'ws-1', tabId: 'tab-a' }, ['pr', 'checks', '1'], Date.now());
    const view = await getGithubUsageView();
    const owner = view.windows[0].owners.find((o) => o.tabId === 'tab-a');
    expect(owner).toMatchObject({ source: 'server', tabName: 'worker-1', workspaceName: 'epic-a', graphql: 1 });
    expect(Date.parse(view.serverLedgerStartedAt)).toBeGreaterThan(Date.now() - HOUR_MS);
  });
});
