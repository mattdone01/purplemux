import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ADR-0028: `purplemux tab restart` sends the flags and maps every restart code to its exit (ADR-0016).

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IRequest { method: string; url: string; body: unknown }

const ANSWER = { ok: true, workspaceId: 'ws-a', tabId: 'tab-t', resumed: true, identity: 'launch', reaped: { killed: 2, survivors: 0 } };

describe('purplemux tab restart (ADR-0028)', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port = 0;
  let home = '';
  let requests: IRequest[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: ANSWER };

  beforeEach(async () => {
    requests = [];
    reply = { status: 200, body: ANSWER };
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-restart-'));
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : null });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });

  const cli = async (args: string[]) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], {
        env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, NO_UPDATE_NOTIFIER: '1', PMUX_PORT: String(port), PMUX_TOKEN: 'ws-token' },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const f = err as { code?: number; stdout?: string; stderr?: string };
      return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
    }
  };

  it('prints "ok TAB restarted (resumed)" and exits 0', async () => {
    const result = await cli(['tab', 'restart', '-w', 'ws-a', 'tab-t']);
    expect(result.code).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('ok tab-t restarted (resumed)');
    expect(result.stdout).toContain('reaped: 2 killed, 0 survivors');
    expect(requests).toEqual([{ method: 'POST', url: '/api/cli/tabs/tab-t/restart?workspaceId=ws-a', body: { clear: false, interrupt: false } }]);
  });

  it('sends --clear and --interrupt, and prints (fresh) with the reason', async () => {
    reply = { status: 200, body: { ...ANSWER, resumed: false, resumeSkipped: 'clear' } };
    const result = await cli(['tab', 'restart', '-w', 'ws-a', 'tab-t', '--clear', '--interrupt']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ok tab-t restarted (fresh)');
    expect(result.stdout).toContain('resume skipped: clear');
    expect(requests[0].body).toEqual({ clear: true, interrupt: true });
  });

  it('--json prints the server answer', async () => {
    const result = await cli(['tab', 'restart', '-w', 'ws-a', 'tab-t', '--json']);
    expect(JSON.parse(result.stdout)).toEqual(ANSWER);
  });

  it('names a held Codex launch', async () => {
    reply = { status: 200, body: { ...ANSWER, resumed: false, launchState: 'held' } };
    const result = await cli(['tab', 'restart', '-w', 'ws-a', 'tab-t']);
    expect(result.stdout).toContain('launch: held');
  });

  it('does not print ok over an answer without ok: true (exit 1)', async () => {
    reply = { status: 200, body: { tabId: 'tab-t' } };
    const result = await cli(['tab', 'restart', '-w', 'ws-a', 'tab-t']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('restart-not-confirmed');
  });

  it.each([
    [400, 'restart-unsupported', 2],
    [403, 'forbidden', 3],
    [409, 'tab-busy', 3],
    [404, 'tab-not-found', 4],
    [503, 'remote-host-unreachable', 6],
    [500, 'restart-not-confirmed', 1],
  ])('HTTP %i %s exits %i', async (status, code, exit) => {
    reply = { status, body: { error: code, code } };
    const result = await cli(['tab', 'restart', '-w', 'ws-a', 'tab-t']);
    expect(result.code).toBe(exit);
    expect(result.stderr).toContain(code);
  });

  it('tab-busy tells the caller about --interrupt', async () => {
    reply = { status: 409, body: { error: 'the tab is mid-turn', code: 'tab-busy' } };
    expect((await cli(['tab', 'restart', '-w', 'ws-a', 'tab-t'])).stderr).toContain('--interrupt');
  });

  it('a missing tab id is a usage error and sends nothing', async () => {
    const result = await cli(['tab', 'restart', '-w', 'ws-a']);
    expect(result.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it('is in usage()', async () => {
    const result = await cli(['help']);
    expect(result.stdout).toContain('tab restart -w WS TAB_ID');
    expect(result.stdout).toContain('[--clear] [--interrupt]');
  });
});
