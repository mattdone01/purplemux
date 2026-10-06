import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-cli-scope-'));
let server: http.Server;
let port: number;
let observed = '';
beforeAll(async () => {
  fs.mkdirSync(path.join(home, '.purplemux'));
  fs.writeFileSync(path.join(home, '.purplemux/cli-token'), 'global');
  fs.writeFileSync(path.join(home, '.purplemux/workspace-tokens.json'), JSON.stringify({ 'ws-target': 'target-token' }));
  server = http.createServer((req, res) => {
    req.resume();
    observed = String(req.headers['x-pmux-token']);
    const allowed = observed === 'target-token' || (observed === 'global' && req.method === 'GET' && req.url?.endsWith('/peers'));
    res.writeHead(allowed ? 200 : 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(allowed ? {} : { error: 'Own workspace required', code: 'forbidden' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});

const commands = [
  ['tab', 'create', '-w', 'ws-target', '--no-launch'],
  ['workspace', 'dirs', 'set', '-w', 'ws-target', '/tmp'],
  ['orchestration', 'on', '-w', 'ws-target', 'tab-target'],
  ['orchestration', 'off', '-w', 'ws-target'],
  ['standup', 'report', '-w', 'ws-target', '--json', '{}'],
];
const cli = async (args: string[], env: Record<string, string | undefined> = {}) => {
  try {
    await run(process.execPath, [path.resolve('bin/purplemux.js'), ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: home, PMUX_PORT: String(port), NO_UPDATE_NOTIFIER: '1', NODE_ENV: 'test', ...env },
    });
    return 0;
  } catch (error) { return (error as { code: number }).code; }
};

describe('installed CLI workspace mutations use production token selection', () => {
  it('preserves global-token peer inspection for the human shell', async () => {
    expect(await cli(['workspace', 'peers', 'show', '-w', 'ws-target'])).toBe(0);
    expect(observed).toBe('global');
  });
  it.each(commands.map((args) => [args.join(' '), args] as const))('unscoped human shell: %s', async (_label, args) => {
    expect(await cli([...args])).toBe(0);
    expect(observed).toBe('target-token');
  });
  for (const env of [{ PMUX_TOKEN: 'foreign-workspace' }, { PMUX_TOKEN: 'target-token', PMUX_TAB_TOKEN: 'foreign-tab' }, { PMUX_TOKEN: 'global' }]) {
    it.each(commands.map((args) => [args.join(' '), args] as const))(`never replaces injected identity ${JSON.stringify(env)}: %s`, async (_label, args) => {
      expect(await cli([...args], env)).toBe(3);
      expect(observed).toBe('PMUX_TAB_TOKEN' in env ? env.PMUX_TAB_TOKEN : env.PMUX_TOKEN);
    });
  }
});
