import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repo = process.cwd();
let home: string;
let server: http.Server;
let port: number;
let sendStatus: number;
let requests: { method: string; url: string; token: string }[];
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-orchestration-'));
  fs.mkdirSync(path.join(home, '.purplemux'));
  fs.writeFileSync(path.join(home, '.purplemux/cli-token'), 'global');
  fs.writeFileSync(path.join(home, '.purplemux/workspace-tokens.json'), JSON.stringify({ 'ws-target': 'target-token' }));
  requests = [];
  sendStatus = 200;
  server = http.createServer((req, res) => {
    req.resume();
    const url = req.url ?? '';
    const token = String(req.headers['x-pmux-token']);
    requests.push({ method: req.method ?? '', url, token });
    const status = req.method === 'POST' ? (token === 'target-token' ? sendStatus : 403) : 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(url.includes('/status?') ? { cliState: 'needs-input', alive: true }
      : url.startsWith('/api/cli/tabs?') ? { tabs: [{ tabId: 'tab-worker', name: 'worker', panelType: 'codex-cli' }] }
        : status >= 400 ? { code: 'forbidden', error: 'Own workspace required' } : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(home, '.purplemux/port'), String(port));
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '', HOME: home, TMPDIR: home, NODE_ENV: 'test', NO_UPDATE_NOTIFIER: '1', ...extra });
const watch = (extra: Record<string, string> = {}) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
  const child = spawn('bash', [path.join(repo, 'orchestration/pmux-watch.sh'), '-w', 'ws-target', '-o', 'tab-orch', '-i', '0.05'], { env: env(extra) });
  let output = '';
  const timeout = setTimeout(() => { child.kill(); reject(new Error(`watchdog did not finish: ${output}`)); }, 5000);
  child.stdout.on('data', (chunk) => {
    output += chunk;
    // Stop after the first successful poll; failures exit on their own.
    if (output.includes('NUDGE -> orchestrator:')) child.kill();
  });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('error', (error) => { clearTimeout(timeout); reject(error); });
  child.on('close', (code) => { clearTimeout(timeout); resolve({ code, output }); });
});

describe('shipped orchestration lifecycle authority', () => {
  it('executes the documented plain-shell lifecycle through the production CLI without global token exports', async () => {
    const doc = fs.readFileSync(path.join(repo, 'orchestration/ORCHESTRATION.md'), 'utf8');
    const kickoff = /## Kickoff \(step by step\)[\s\S]*?```bash\n([\s\S]*?)```/.exec(doc)![1]
      .replaceAll('WS_ID', 'ws-target').replaceAll('ORCH_TAB_ID', 'tab-orch');
    expect(doc).not.toMatch(/export PMUX_TOKEN=/);
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin/purplemux'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(repo, 'bin/purplemux.js')}' "$@"\n`, { mode: 0o755 });
    // The background watchdog is tested below; this fixture lets the documented
    // foreground sequence finish so its real create/send CLI calls are observed.
    fs.mkdirSync(path.join(home, 'orchestration'));
    fs.writeFileSync(path.join(home, 'orchestration/pmux-watch.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(home, 'kickoff-prompt.md'), 'isolated fixture kickoff');
    await run('bash', ['-eu', '-c', kickoff], { cwd: home, env: env({ PATH: `${home}/bin:${process.env.PATH}` }) });
    expect(requests.filter((r) => r.method === 'POST').map((r) => [r.url, r.token])).toEqual([
      ['/api/cli/tabs', 'target-token'], ['/api/cli/tabs/tab-orch/send?workspaceId=ws-target', 'target-token'],
    ]);
  });
  it('uses the target workspace credential for an unscoped watchdog', async () => {
    const result = await watch();
    expect(result.output).toContain('NUDGE -> orchestrator:');
    expect(requests.every((r) => r.token === 'target-token')).toBe(true);
    expect(requests.some((r) => r.method === 'POST')).toBe(true);
  });
  const injectedCredentials: Record<string, string>[] = [{ PMUX_TOKEN: 'global' }, { PMUX_TOKEN: 'foreign-workspace' }, { PMUX_TOKEN: 'target-token', PMUX_TAB_TOKEN: 'foreign-tab' }];
  it.each(injectedCredentials)('preserves injected identity and reports denied delivery: %j', async (extra) => {
    const result = await watch(extra);
    expect(result.code).toBe(1);
    expect(result.output).toContain('NUDGE FAILED');
    expect(result.output).toContain('403');
    expect(result.output).not.toContain('NUDGE -> orchestrator:');
    expect(requests.find((r) => r.method === 'POST')?.token).toBe(extra.PMUX_TAB_TOKEN ?? extra.PMUX_TOKEN);
    expect(fs.existsSync(path.join(home, 'pmux-watch-ws-target/tab-worker'))).toBe(false);
  });
  it.each([302, 500])('reports unsuccessful HTTP %s sends and leaves delivery pending', async (status) => {
    sendStatus = status;
    const result = await watch();
    expect(result.code).toBe(1);
    expect(result.output).toContain('NUDGE FAILED');
    expect(result.output).toContain(String(status));
    expect(result.output).not.toContain('NUDGE -> orchestrator:');
    expect(fs.existsSync(path.join(home, 'pmux-watch-ws-target/tab-worker'))).toBe(false);
  });
  it('fails before HTTP when no target credential exists, without global fallback', async () => {
    fs.writeFileSync(path.join(home, '.purplemux/workspace-tokens.json'), '{}');
    const result = await watch();
    expect(result.code).toBe(1);
    expect(result.output).toContain('no workspace credential for ws-target');
    expect(requests).toEqual([]);
  });
});
