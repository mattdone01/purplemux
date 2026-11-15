import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ADR-0048: `purplemux tab keep` sends the keep mark as PATCH { keep } and refuses a malformed call before any request.

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IRequest { method: string; url: string; body: unknown }

const ANSWER = { tabId: 'tab-t', workspaceId: 'ws-a', keep: { until: null, reason: 'lead seat', at: 1 } };

describe('purplemux tab keep (ADR-0048)', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port = 0;
  let home = '';
  let requests: IRequest[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: ANSWER };

  beforeEach(async () => {
    requests = [];
    reply = { status: 200, body: ANSWER };
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-keep-'));
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

  it('sends the reason and the until as given', async () => {
    const result = await cli(['tab', 'keep', '-w', 'ws-a', 'tab-t', '--reason', 'owner review', '--until', '12h']);
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ method: 'PATCH', url: '/api/cli/tabs/tab-t?workspaceId=ws-a', body: { keep: { reason: 'owner review', until: '12h' } } }]);
    expect(JSON.parse(result.stdout)).toEqual(ANSWER);
  });

  it('sends a keep with no until, and --clear as null', async () => {
    await cli(['tab', 'keep', '-w', 'ws-a', 'tab-t', '--reason', 'lead seat']);
    await cli(['tab', 'keep', '-w', 'ws-a', 'tab-t', '--clear']);
    expect(requests.map((r) => r.body)).toEqual([{ keep: { reason: 'lead seat' } }, { keep: null }]);
  });

  it.each([
    [['tab', 'keep', '-w', 'ws-a', 'tab-t']],
    [['tab', 'keep', '-w', 'ws-a', 'tab-t', '--clear', '--reason', 'x']],
    [['tab', 'keep', '-w', 'ws-a', '--reason', 'x']],
    [['tab', 'keep', 'tab-t', '--reason', 'x']],
  ])('refuses %j with exit 2 and sends nothing', async (args) => {
    const result = await cli(args);
    expect(result.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it('passes the server refusal through', async () => {
    reply = { status: 400, body: { error: 'until must be in the future' } };
    const result = await cli(['tab', 'keep', '-w', 'ws-a', 'tab-t', '--reason', 'x', '--until', '2020-01-01T00:00:00Z']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('until must be in the future');
  });
});
