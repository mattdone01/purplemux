import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ADR-0050: queueing is the default; `--no-queue`, `--supersede KEY` and `--ttl-min N` reach the route;
// `inbox show ID` reads one item's delivery state; a full queue exits 3.

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IRequest { method: string; url: string; body: unknown }

describe('purplemux tab send: the busy-tab queue flags (ADR-0050)', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port = 0;
  let home = '';
  let requests: IRequest[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  beforeEach(async () => {
    requests = [];
    reply = { status: 200, body: { status: 'queued', submitted: false, messageId: 'i-abc123', delivery: 'queued' } };
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-queue-'));
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

  const SEND_URL = '/api/cli/tabs/tab-1/send?workspaceId=ws-A';

  it('old-cli-reads-queued-exit0: a queued answer is printed and exits 0', async () => {
    const result = await cli(['tab', 'send', '-w', 'ws-A', 'tab-1', 'please', 'rebase']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'queued', submitted: false, messageId: 'i-abc123', delivery: 'queued' });
    expect(requests).toEqual([{ method: 'POST', url: SEND_URL, body: { content: 'please rebase' } }]);
  });

  it('sends --no-queue, --supersede and --ttl-min as the route reads them', async () => {
    await cli(['tab', 'send', '-w', 'ws-A', '--no-queue', '--supersede', 'pr-12.taken', '--ttl-min', '30', 'tab-1', 'taken']);
    expect(requests[0].body).toEqual({ content: 'taken', noQueue: true, supersede: 'pr-12.taken', ttlMin: 30 });
  });

  it.each([
    [['--supersede', 'a b'], '--supersede'],
    [['--supersede', 'k'.repeat(65)], '--supersede'],
    [['--ttl-min', '0'], '--ttl-min'],
    [['--ttl-min', '1441'], '--ttl-min'],
    [['--ttl-min', 'soon'], '--ttl-min'],
  ])('refuses %j with exit 2 before any request', async (flags, name) => {
    const result = await cli(['tab', 'send', '-w', 'ws-A', ...flags, 'tab-1', 'x']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(name);
    expect(requests).toEqual([]);
  });

  it('message-queue-cap: a full queue exits 3', async () => {
    reply = { status: 409, body: { error: 'the message queue of tab tab-1 is full (20)', code: 'message-queue-full', tabId: 'tab-1' } };
    const result = await cli(['tab', 'send', '-w', 'ws-A', 'tab-1', 'x']);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('message-queue-full');
  });

  it('inbox show ID reads one item and prints it', async () => {
    reply = { status: 200, body: { item: { id: 'i-abc123', delivery: 'delivered' } } };
    const result = await cli(['inbox', 'show', 'i-abc123']);
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ method: 'GET', url: '/api/cli/inbox/i-abc123', body: null }]);
    expect(JSON.parse(result.stdout)).toEqual({ item: { id: 'i-abc123', delivery: 'delivered' } });
  });

  it('inbox show refuses a malformed id with exit 2', async () => {
    const result = await cli(['inbox', 'show', 'n-abc']);
    expect(result.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it('note send --supersede KEY sends the key', async () => {
    const body = path.join(home, 'body.txt');
    await fs.writeFile(body, 'PR 12 is free');
    reply = { status: 200, body: { note: { id: 'n-abcd1' } } };
    await cli(['note', 'send', '--to-workspace', 'ws-A', '--subject', 'released', '-f', body, '--supersede', 'pr-12']);
    expect(requests[0].body).toEqual({ subject: 'released', body: 'PR 12 is free', toWorkspace: 'ws-A', supersedeKey: 'pr-12' });
  });
});
