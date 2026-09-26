import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// The installed entry point, never bin/cli.js: `~/.local/bin/purplemux`
// resolves to bin/purplemux.js, and a command it does not register answers
// `unknown command` before cli.js ever runs.
const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IRecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

type TStubReply = (req: IRecordedRequest, res: http.ServerResponse) => void;

let server: http.Server;
let port = 0;
let reply: TStubReply = (_req, res) => res.end();
const requests: IRecordedRequest[] = [];

const json = (status: number, body: unknown): TStubReply => (_req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** A port nothing listens on: bind it, then release it. */
const closedPort = async (): Promise<number> => {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port: free } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return free;
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-cli-exit-'));

const cli = async (
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], {
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH ?? '',
        HOME: home,
        NO_UPDATE_NOTIFIER: '1',
        PMUX_PORT: String(port),
        PMUX_TOKEN: 'test-token',
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const recorded = { method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined };
      requests.push(recorded);
      reply(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  requests.length = 0;
  reply = (_req, res) => res.end();
});

describe('tab send — permanent and retryable failures are distinct', () => {
  it('exits 4 for a tab that does not exist, and says not to retry', async () => {
    reply = json(404, { error: 'Tab not found', code: 'tab-not-found' });

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(4);
    expect(stderr).toContain('tab-not-found');
    expect(stderr).toContain('do not retry');
  });

  it('exits 4 for a tab whose tmux session is dead', async () => {
    reply = json(409, {
      error: 'agent-not-ready',
      code: 'session-not-running',
      tabId: 'tab-x',
      cliState: null,
      detail: 'session-not-running',
    });

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(4);
    expect(stderr).toContain('session-not-running');
    expect(stderr).toContain('do not retry');
  });

  it('exits 5 for an agent that never became ready, naming the waited milliseconds', async () => {
    reply = json(409, {
      error: 'agent-not-ready',
      code: 'readiness-timeout',
      tabId: 'tab-x',
      cliState: 'inactive',
      detail: 'readiness-timeout',
      waitedMs: 1000,
    });

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', '--wait-ms', '1000', 'tab-x', 'hi']);

    expect(code).toBe(5);
    expect(stderr).toContain('readiness-timeout');
    expect(stderr).toContain('1000 ms');
    expect(requests[0].body).toEqual({ content: 'hi', waitMs: 1000 });
  });

  it('exits 4 for a tab replaced while the send waited', async () => {
    reply = json(409, { error: 'agent-target-changed', code: 'target-changed', tabId: 'tab-x' });

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(4);
    expect(stderr).toContain('target-changed');
  });

  it('still classifies the bodies a pre-contract server returns', async () => {
    reply = json(404, { error: 'Tab not found' });
    expect((await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi'])).code).toBe(4);

    reply = json(409, { error: 'agent-not-ready', detail: 'readiness-timeout', waitedMs: 5 });
    expect((await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi'])).code).toBe(5);

    reply = json(409, { error: 'agent-not-ready', detail: 'session-not-running' });
    expect((await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi'])).code).toBe(4);

    reply = json(409, { error: 'agent-target-changed', tabId: 'tab-x' });
    expect((await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi'])).code).toBe(4);

    reply = json(409, { error: 'Tab session is not running' });
    expect((await cli(['tab', 'result', '-w', 'WS', 'tab-x'])).code).toBe(4);

    reply = json(409, { error: 'session not found' });
    expect((await cli(['tab', 'steer', '-w', 'WS', 'tab-x', 'fix it'])).code).toBe(4);
  });

  it('exits 1 for a success that is not JSON: another server holds the port', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    };

    const { code, stdout, stderr } = await cli(['tab', 'status', '-w', 'WS', 'tab-x']);

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('without a JSON body');
  });

  it('accepts the longest wait the CLI can hold open', async () => {
    reply = json(200, { status: 'sent', submitted: true, cliState: 'idle' });

    const { code } = await cli(['tab', 'send', '-w', 'WS', '--wait-ms', '240000', 'tab-x', 'hi']);

    expect(code).toBe(0);
    expect(requests[0].body).toEqual({ content: 'hi', waitMs: 240000 });
  });

  it('prints the success body and exits 0', async () => {
    reply = json(200, { status: 'sent', submitted: true, cliState: 'idle' });

    const { code, stdout } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ status: 'sent', submitted: true, cliState: 'idle' });
  });
});

describe('the code → exit table', () => {
  // The pinned table in architecture.md "CLI exit-code contract". Later
  // stories add routes that return these codes; the CLI already maps them.
  const TABLE: Array<[string, number]> = [
    ['gh-unavailable', 1],
    ['lease-policy', 2],
    ['watch-invalid', 2],
    ['reports-to-invalid', 2],
    ['note-too-large', 2],
    ['config-invalid', 2],
    ['note-target-missing', 2],
    ['lease-held', 3],
    ['lease-held-by-other', 3],
    ['watch-cap', 3],
    ['forbidden', 3],
    ['inbox-not-held', 3],
    ['grant-tab-unverified', 3],
    ['config-version-conflict', 3],
    ['caller-unresolved', 3],
    ['grant-password-invalid', 3],
    ['grant-locked', 3],
    ['tab-not-found', 4],
    ['session-not-running', 4],
    ['target-changed', 4],
    ['readiness-timeout', 5],
    ['lease-not-found', 7],
    ['note-not-found', 7],
    ['watch-not-found', 7],
    ['inbox-not-found', 7],
    ['deploy-not-found', 7],
    ['config-not-found', 7],
  ];

  it.each(TABLE)('maps %s to exit %i', async (code, exit) => {
    reply = json(409, { error: `server said ${code}`, code });

    const result = await cli(['tab', 'status', '-w', 'WS', 'tab-x']);

    expect(result.code).toBe(exit);
    expect(result.stderr).toContain(code);
    expect(result.stderr).toContain(`server said ${code}`);
  });

  it('exits 1 for a code the table does not know', async () => {
    reply = json(409, { error: 'agent-model-mismatch', tabId: 'tab-x' });

    const { code, stderr } = await cli(['tab', 'status', '-w', 'WS', 'tab-x']);

    expect(code).toBe(1);
    expect(stderr).toContain('agent-model-mismatch');
  });

  it('exits 1 for a 5xx without a body', async () => {
    reply = (_req, res) => { res.writeHead(500); res.end(); };

    const { code, stderr } = await cli(['tab', 'status', '-w', 'WS', 'tab-x']);

    expect(code).toBe(1);
    expect(stderr).toContain('HTTP 500');
  });

  it('does not let an inherited prototype key pass as a code', async () => {
    reply = json(409, { error: 'odd', code: 'constructor' });

    expect((await cli(['tab', 'status', '-w', 'WS', 'tab-x'])).code).toBe(1);
  });
});

describe('server unreachable', () => {
  it.each([
    [['workspaces']],
    [['tab', 'list', '-w', 'WS']],
    [['tab', 'send', '-w', 'WS', 'tab-x', 'hi']],
    [['tab', 'close', '-w', 'WS', 'tab-x']],
    [['api-guide']],
    [['tab', 'browser', 'screenshot', '-w', 'WS', 'tab-x', '-o', path.join(home, 'shot.png')]],
  ])('exits 6 for %j when nothing listens on the port', async (args) => {
    const { code, stderr } = await cli(args, { PMUX_PORT: String(await closedPort()) });

    expect(code).toBe(6);
    expect(stderr).toContain('server-unreachable');
  });

  it('exits 6 when no port is configured at all', async () => {
    const { code } = await cli(['workspaces'], { PMUX_PORT: '' });
    expect(code).toBe(6);
  });

  it('exits 6 when no token is configured at all', async () => {
    const { code, stderr } = await cli(['workspaces'], { PMUX_TOKEN: '' });
    expect(code).toBe(6);
    expect(stderr).toContain('server-unreachable');
    expect(requests).toHaveLength(0);
  });

  it.each([
    [['tab', 'status', '-w', 'WS', 'tab-x']],
    [['tab', 'send', '-w', 'WS', 'tab-x', 'hi']],
  ])('exits 1 for %j when the request could never be sent (a malformed port)', async (args) => {
    const { code, stderr } = await cli(args, { PMUX_PORT: 'abc' });

    expect(code).toBe(1);
    expect(stderr).toContain('request not sent');
    expect(stderr).not.toContain('outcome unknown');
  });

  it('exits 1 for a write to a port fetch refuses: `fetch failed` with an uncoded cause', async () => {
    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi'], { PMUX_PORT: '1' });

    expect(code).toBe(1);
    expect(stderr).toContain('request not sent');
    expect(stderr).not.toContain('outcome unknown');
  });

  it('exits 6 when a screenshot download loses its connection mid-body', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '100000' });
      res.write(Buffer.alloc(10));
      setTimeout(() => res.socket?.destroy(), 20);
    };

    const { code, stderr } = await cli(
      ['tab', 'browser', 'screenshot', '-w', 'WS', 'tab-x', '-o', path.join(home, 'partial.png')],
    );

    expect(code).toBe(6);
    expect(stderr).toContain('server-unreachable');
  });

  it('exits 6 when a read loses its connection mid-request', async () => {
    reply = (_req, res) => res.socket?.destroy();

    const { code } = await cli(['tab', 'status', '-w', 'WS', 'tab-x']);

    expect(code).toBe(6);
  });

  it('exits 1, not 6, when a write loses its connection: the outcome is unknown', async () => {
    reply = (_req, res) => res.socket?.destroy();

    const { code, stderr } = await cli(['tab', 'send', '-w', 'WS', 'tab-x', 'hi']);

    expect(code).toBe(1);
    expect(stderr).toContain('outcome unknown');
  });
});

describe('usage errors exit 2', () => {
  it.each([
    [['tab', 'send', '-w', 'WS']],
    [['tab', 'send', '-w', 'WS', 'tab-x']],
    [['tab', 'send', 'tab-x', 'hi']],
    [['tab', 'send', '-w', 'WS', 'tab-x', 'hi', '--wait-ms']],
    [['tab', 'send', '-w', 'WS', '--wait-ms', '240001', 'tab-x', 'hi']],
    [['nonsense']],
    [['tab', 'status']],
    [['tab', 'probe', 'set', '-w', 'WS', 'tab-x']],
    [['tab', 'nonsense']],
    [['workspace', 'nonsense']],
    [['mission', 'ack', '-w', 'WS']],
    [['orchestration', 'nonsense', '-w', 'WS']],
  ])('%j', async (args) => {
    const { code, stderr } = await cli(args);

    expect(code).toBe(2);
    expect(stderr).toContain('usage error');
    expect(requests).toHaveLength(0);
  });
});

describe('tab close', () => {
  it('prints ok when the server confirms the close', async () => {
    reply = json(200, { ok: true });

    const { code, stdout } = await cli(['tab', 'close', '-w', 'WS', 'tab-x']);

    expect(code).toBe(0);
    expect(stdout).toBe('ok\n');
  });

  it('does not print ok when the server answered ok: false', async () => {
    reply = json(200, { ok: false });

    const { code, stdout, stderr } = await cli(['tab', 'close', '-w', 'WS', 'tab-x']);

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('close-not-confirmed');
  });

  it('exits 4 for a tab that is already gone', async () => {
    reply = json(404, { error: 'Tab not found', code: 'tab-not-found' });

    expect((await cli(['tab', 'close', '-w', 'WS', 'tab-x'])).code).toBe(4);
  });
});

describe('api-guide', () => {
  it('prints the guide and exits 0', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end('# guide');
    };

    const { code, stdout } = await cli(['api-guide']);

    expect(code).toBe(0);
    expect(stdout).toBe('# guide\n');
    expect(requests[0].url).toBe('/api/cli/api-guide');
  });

  it('maps a refusal through the table', async () => {
    reply = json(403, { error: 'Forbidden', code: 'forbidden' });

    expect((await cli(['api-guide'])).code).toBe(3);
  });
});

describe('help', () => {
  it('lists the eight exit codes with the retry column', async () => {
    const { code, stdout } = await cli(['help']);

    expect(code).toBe(0);
    expect(stdout).toContain('Exit codes:');
    const section = stdout.slice(stdout.indexOf('Exit codes:'));
    for (const exit of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(section).toMatch(new RegExp(`^\\s+${exit}\\s`, 'm'));
    }
    expect(section).toMatch(/^\s+4\s.*never/m);
    expect(section).toMatch(/^\s+5\s.*bounded/m);
    expect(section).toMatch(/^\s+6\s.*bounded/m);
  });

  it('tells a tab send caller not to loop on exit 4', async () => {
    const { stdout } = await cli(['help']);
    const send = stdout.slice(stdout.indexOf('tab send -w WS'), stdout.indexOf('tab status -w WS'));
    expect(send).toMatch(/exit 4/i);
    expect(send).toMatch(/never retry/i);
  });

  it.each([['--help'], ['-h']])('answers %s through the installed entry point', async (flag) => {
    const { code, stdout } = await cli([flag]);
    expect(code).toBe(0);
    expect(stdout).toContain('Exit codes:');
  });
});
