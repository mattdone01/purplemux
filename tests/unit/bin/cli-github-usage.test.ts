import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// engineering#810: `purplemux github usage` through the installed entry point, against a stub server.

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

const VIEW = {
  at: '2026-11-18T08:00:00.000Z',
  quotaReadAt: '2026-11-18T07:58:00.000Z',
  quotaError: null,
  accounts: [
    {
      login: 'mattdone-ai', role: 'agent', state: 'read', readAt: 1,
      core: { remaining: 812, limit: 5000, reset: 1_763_454_000 }, graphql: { remaining: 4990, limit: 5000, reset: 1_763_455_500 },
    },
    { login: 'bot-2', role: 'agent', state: 'unknown', reason: 'rate_limit did not parse', readAt: 1 },
    { login: 'mattdone01', role: 'owner', state: 'not-read', reason: 'not read (owner account)' },
  ],
  windows: [
    {
      window: '1h', total: 130, rest: 100, graphql: 30, ownersOmitted: 0,
      owners: [
        {
          source: 'tab', workspaceId: 'ws-1', workspaceName: 'epic-a', tabId: 'tab-a', tabName: 'worker-1', rest: 90, graphql: 10, total: 100,
          top: [{ command: 'api rest', count: 80 }, { command: 'pr checks', count: 10 }, { command: 'run view', count: 10 }],
        },
        { source: 'server', workspaceId: 'ws-1', workspaceName: null, tabId: 'tab-b', tabName: null, rest: 0, graphql: 20, total: 20, top: [{ command: 'api graphql', count: 20 }] },
        { source: 'tab', workspaceId: '-', workspaceName: null, tabId: '-', tabName: null, rest: 10, graphql: 0, total: 10, top: [{ command: 'run list', count: 10 }] },
      ],
    },
    { window: '24h', total: 0, rest: 0, graphql: 0, ownersOmitted: 0, owners: [] },
  ],
  serverLedgerStartedAt: '2026-11-18T05:00:00.000Z',
  tabLog: { dir: '/h/.local/state/purplemux/gh-calls', shimInstalled: true, shimReason: null, error: null, skippedLines: 0 },
  footer: [
    'server ledger since 2026-11-18T05:00:00.000Z (in memory: a restart starts it again)',
    'residual: a script that resets PATH, or one that runs gh by an absolute path such as /usr/bin/gh, is not counted, so the count can be low; remote tabs are not counted',
  ],
};

describe('purplemux github usage (engineering#810)', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port = 0;
  let home = '';
  let urls: string[] = [];

  beforeEach(async () => {
    urls = [];
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-gh-'));
    server = http.createServer((req, res) => {
      urls.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(VIEW));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });

  const cli = async (args: string[]) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [ENTRY, 'github', ...args], {
        env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, NO_UPDATE_NOTIFIER: '1', PMUX_PORT: String(port), PMUX_TAB_TOKEN: 'tab-token', TZ: 'UTC' },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const f = err as { code?: number; stdout?: string; stderr?: string };
      return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
    }
  };

  it('prints the accounts, the owners of each window and the residual footer', async () => {
    const r = await cli(['usage']);
    expect(r.code).toBe(0);
    expect(urls).toEqual(['GET /api/cli/github-usage']);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe('github usage at 2026-11-18T08:00:00.000Z (quota read 2026-11-18T07:58:00.000Z)');
    expect(r.stdout).toMatch(/^ACCOUNT\s+ROLE\s+REST\s+REST RESET\s+GRAPHQL\s+GRAPHQL RESET$/m);
    expect(r.stdout).toMatch(/^mattdone-ai\s+agent\s+812\/5000 \(16%\)\s+2025-11-18T08:20:00Z\s+4990\/5000 \(99%\)\s+2025-11-18T08:45:00Z$/m);
    expect(r.stdout).toMatch(/^bot-2\s+agent\s+unknown \(rate_limit did not parse\)$/m);
    expect(r.stdout).toMatch(/^mattdone01\s+owner\s+not read \(owner account\)$/m);
    expect(r.stdout).toContain('last 1h: 130 calls (100 REST, 30 GraphQL)');
    expect(r.stdout).toMatch(/^TAB\s+WORKSPACE\s+SOURCE\s+REST\s+GRAPHQL\s+TOP SUBCOMMANDS$/m);
    expect(r.stdout).toMatch(/^worker-1 \(tab-a\)\s+epic-a\s+tab\s+90\s+10\s+api rest 80, pr checks 10, run view 10$/m);
    expect(r.stdout).toMatch(/^tab-b\s+ws-1\s+server\s+0\s+20\s+api graphql 20$/m);
    expect(r.stdout).toMatch(/^-\s+-\s+tab\s+10\s+0\s+run list 10$/m);
    expect(r.stdout).toContain('last 24h: 0 calls (0 REST, 0 GraphQL)\n  no calls counted');
    expect(r.stdout).toContain('note: server ledger since 2026-11-18T05:00:00.000Z (in memory: a restart starts it again)');
    expect(r.stdout).toContain('note: residual: a script that resets PATH, or one that runs gh by an absolute path such as /usr/bin/gh, is not counted');
  });

  it('--json prints the served view', async () => {
    const r = await cli(['usage', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(VIEW);
  });

  it('refuses an unknown subcommand as a usage error', async () => {
    const r = await cli(['spend']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('purplemux github usage [--json]');
    expect(urls).toEqual([]);
  });
});
