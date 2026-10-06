import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin', 'purplemux.js');

interface IRecorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let conflict = false;
let server: http.Server;
let port: number;
let recorded: IRecorded[];
let home: string;
let fakeBin: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (conflict && req.method === 'PATCH') {
        res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'orchestration-conflict', error: 'changed', orchestration: { revision: 8 } })); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ orchestration: { revision: 7 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  recorded = [];
  conflict = false;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-identity-'));
  fakeBin = path.join(home, 'bin');
  await fs.mkdir(fakeBin);
  await fs.writeFile(path.join(fakeBin, 'tmux'), '#!/bin/sh\necho "${FAKE_TMUX_SESSION}"\n', { mode: 0o755 });
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/** A clean environment: nothing from the test runner's own tab may leak into the CLI under test. */
const cli = async (args: string[], env: Record<string, string>) => {
  await run('node', [ENTRY, ...args], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      HOME: home,
      PMUX_PORT: String(port),
      NO_UPDATE_NOTIFIER: '1',
      NODE_ENV: 'test',
      ...env,
    },
  });
  expect(recorded).toHaveLength(args[0] === 'orchestration' ? 2 : 1);
  return recorded[recorded.length - 1];
};

describe('purplemux CLI caller identity', () => {
  it('presents PMUX_TAB_TOKEN over PMUX_TOKEN, and sends no session assertion with it', async () => {
    const call = await cli(['tab', 'list', '-w', 'ws-a'], {
      PMUX_TAB_TOKEN: 'tab-token',
      PMUX_TOKEN: 'ws-token',
      TMUX: '/tmp/fake,1,0',
      FAKE_TMUX_SESSION: 'pt-ws-a-pane-1-tab-1',
    });
    expect(call.headers['x-pmux-token']).toBe('tab-token');
    expect(call.headers['x-pmux-session']).toBeUndefined();
  });

  it('presents PMUX_TOKEN with the tmux session name when no tab token exists', async () => {
    const call = await cli(['tab', 'list', '-w', 'ws-a'], {
      PMUX_TOKEN: 'ws-token',
      TMUX: '/tmp/fake,1,0',
      FAKE_TMUX_SESSION: 'pt-ws-a-pane-1-tab-1',
    });
    expect(call.headers['x-pmux-token']).toBe('ws-token');
    expect(call.headers['x-pmux-session']).toBe('pt-ws-a-pane-1-tab-1');
  });

  it('sends no session assertion outside tmux', async () => {
    const call = await cli(['tab', 'list', '-w', 'ws-a'], { PMUX_TOKEN: 'ws-token', FAKE_TMUX_SESSION: 'pt-ws-a-pane-1-tab-1' });
    expect(call.headers['x-pmux-session']).toBeUndefined();
  });

  it('falls back to the -w workspace token on disk, then to the global token', async () => {
    const dir = path.join(home, '.purplemux');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'cli-token'), 'admin-token');
    await fs.writeFile(path.join(dir, 'workspace-tokens.json'), JSON.stringify({ 'ws-a': 'disk-ws-token' }));

    expect((await cli(['tab', 'list', '-w', 'ws-a'], {})).headers['x-pmux-token']).toBe('disk-ws-token');
    recorded = [];
    expect((await cli(['tab', 'list', '-w', 'ws-z'], {})).headers['x-pmux-token']).toBe('admin-token');
  });

  it('designates PMUX_TAB_ID as its own tab without asking tmux', async () => {
    // The fake tmux would name another tab; PMUX_TAB_ID must win.
    const call = await cli(['orchestration', 'on', '-w', 'ws-a'], {
      PMUX_TAB_TOKEN: 'tab-token',
      PMUX_TAB_ID: 'tab-own',
      TMUX: '/tmp/fake,1,0',
      FAKE_TMUX_SESSION: 'pt-ws-a-pane-1-tab-other',
    });
    expect(call.method).toBe('PATCH');
    expect(JSON.parse(call.body)).toEqual({ enabled: true, orchestratorTabId: 'tab-own', expectedRevision: 7, mode: 'recover' });
  });

  it('still parses the session name for a tab created before PMUX_TAB_ID existed', async () => {
    const call = await cli(['orchestration', 'on', '-w', 'ws-a'], {
      PMUX_TOKEN: 'ws-token',
      TMUX: '/tmp/fake,1,0',
      FAKE_TMUX_SESSION: 'pt-ws-a-pane-1-tab-legacy',
    });
    expect(JSON.parse(call.body)).toEqual({ enabled: true, orchestratorTabId: 'tab-legacy', expectedRevision: 7, mode: 'recover' });
    expect(call.headers['x-pmux-session']).toBe('pt-ws-a-pane-1-tab-legacy');
  });
});

it.each(['recover', 'handoff', 'off'])('production CLI %s submits one displayed revision and never retries a conflict', async (mode) => {
  conflict = true;
  await expect(cli(['orchestration', mode, '-w', 'ws-a', 'tab-target'], { PMUX_TAB_TOKEN: 'tab-token' })).rejects.toMatchObject({ code: 3 });
  expect(recorded.map((call) => call.method)).toEqual(['GET', 'PATCH']);
  expect(JSON.parse(recorded[1].body)).toMatchObject({ expectedRevision: 7, mode: mode === 'off' ? 'update' : mode });
});
