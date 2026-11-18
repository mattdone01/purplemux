import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// `purplemux tab orphans` lists by default, reaps with --reap, and maps the sweep's refusals to their exits.

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IRequest { method: string; url: string; body: unknown }

const ANSWER = {
  hosts: [
    { host: 'local', status: 'ok', orphans: [
      { kind: 'unowned-tab', pid: 301, ppid: 1, comm: 'sleep', ageS: 600, cwd: '/work/a', tabId: 'tab-gone' },
      { kind: 'unowned-session', session: 'pt-ws-test1-pane-p1-tab-cccc', ageS: 900 },
    ] },
    { host: 'host-a', status: 'unreachable', error: 'the orphan scan on host-a did not answer (timed out)', orphans: [] },
  ],
};

describe('purplemux tab orphans', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port = 0;
  let home = '';
  let requests: IRequest[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: ANSWER };

  beforeEach(async () => {
    requests = [];
    reply = { status: 200, body: ANSWER };
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-orphans-'));
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

  it('lists per host with a GET, one line per orphan', async () => {
    const result = await cli(['tab', 'orphans']);
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ method: 'GET', url: '/api/cli/tabs/orphans', body: null }]);
    expect(result.stdout.split('\n')).toEqual([
      'local: 2 orphans',
      '  unowned-tab pid 301 ppid 1 sleep age 600s tab tab-gone cwd /work/a',
      '  unowned-session pt-ws-test1-pane-p1-tab-cccc age 900s',
      'host-a: unreachable (the orphan scan on host-a did not answer (timed out))',
      '',
    ]);
  });

  it('--host names one host; --reap POSTs and prints each outcome', async () => {
    await cli(['tab', 'orphans', '--host', 'host-a']);
    expect(requests[0].url).toBe('/api/cli/tabs/orphans?host=host-a');
    reply = { status: 200, body: { hosts: [{ host: 'local', status: 'ok', orphans: [], reaped: [
      { pid: 301, comm: 'sleep', tabId: 'tab-gone', kind: 'unowned-tab', outcome: 'killed' },
      { pid: 302, comm: 'claude', tabId: 'tab-aaaa', kind: 'duplicate-agent', outcome: 'refused', refusal: 'held-by-session' },
    ] }] } };
    const result = await cli(['tab', 'orphans', '--reap', '--host', 'local']);
    expect(result.code).toBe(0);
    expect(requests[1]).toEqual({ method: 'POST', url: '/api/cli/tabs/orphans', body: { reap: true, host: 'local' } });
    expect(result.stdout).toContain('  killed pid 301 sleep unowned-tab tab tab-gone');
    expect(result.stdout).toContain('  refused pid 302 claude duplicate-agent tab tab-aaaa (held-by-session)');
  });

  it('a host whose pane tree was not read says so, and that nothing there is reaped', async () => {
    reply = { status: 200, body: { hosts: [{ host: 'host-a', status: 'ok', tree: { complete: false, reason: 'tmux failed' }, orphans: [] }] } };
    const result = await cli(['tab', 'orphans', '--host', 'host-a']);
    expect(result.stdout).toBe('host-a: 0 orphans [pane tree unreadable: tmux failed; nothing here is reaped]\n');
  });

  it('--json prints the server answer', async () => {
    expect(JSON.parse((await cli(['tab', 'orphans', '--json'])).stdout)).toEqual(ANSWER);
  });

  it('maps the refusals: a host outside remote.hosts exits 2, a forbidden reap and an unreadable layout exit 3', async () => {
    reply = { status: 400, body: { error: 'host-z is not a host', code: 'remote-host-invalid' } };
    expect((await cli(['tab', 'orphans', '--host', 'host-z'])).code).toBe(2);
    reply = { status: 403, body: { error: 'forbidden', code: 'forbidden' } };
    expect((await cli(['tab', 'orphans', '--reap'])).code).toBe(3);
    reply = { status: 409, body: { error: 'the layout of ws-test1 is unreadable', code: 'conflict' } };
    expect((await cli(['tab', 'orphans'])).code).toBe(3);
  });

  it('a stray argument is a usage error and sends nothing', async () => {
    const result = await cli(['tab', 'orphans', 'extra']);
    expect(result.code).toBe(2);
    expect(requests).toEqual([]);
  });
});
