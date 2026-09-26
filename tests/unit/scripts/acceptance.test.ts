import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Story 07: the isolated acceptance harness that gates every forward deploy (scripts/acceptance/).
// These tests pin its judgements and its safety rules with fakes; the end-to-end run against a real
// build is opt-in (ACCEPTANCE_E2E_CANDIDATE) because it needs a built candidate and ~90 s.

const ROOT = path.resolve(__dirname, '../../..');
const INSTANCE = path.join(ROOT, 'scripts/acceptance/isolated-instance.sh');
const RUN = path.join(ROOT, 'scripts/acceptance/run.sh');
const checks = createRequire(import.meta.url)(path.join(ROOT, 'scripts/acceptance/checks.cjs'));

// Next types NODE_ENV as required on ProcessEnv; a child's environment here is deliberately minimal.
const asEnv = (env: Record<string, string | undefined>) => env as NodeJS.ProcessEnv;

describe('checks.cjs judgements', () => {
  it('judgeRace: exactly one winner and one refusal that names the winner', () => {
    const win = { rc: 0, out: '', err: '' };
    const lose = { rc: 3, out: '', err: 'error: lease-held — merge:x/y held by ws-a / tab-A1 (acc-a1)' };
    expect(checks.judgeRace(win, lose, 'tab-A1', 'tab-B1')).toEqual({ ok: true, winnerId: 'tab-A1', loserId: 'tab-B1' });
    expect(checks.judgeRace({ ...lose, err: 'held by tab-B1' }, win, 'tab-A1', 'tab-B1')).toEqual({ ok: true, winnerId: 'tab-B1', loserId: 'tab-A1' });
  });

  it('judgeRace fails two winners, two refusals, and a refusal that does not name the holder', () => {
    const win = { rc: 0, out: '', err: '' };
    expect(checks.judgeRace(win, win, 'a', 'b').ok).toBe(false);
    expect(checks.judgeRace({ rc: 3, out: '', err: '' }, { rc: 3, out: '', err: '' }, 'a', 'b').ok).toBe(false);
    const anonymous = checks.judgeRace(win, { rc: 3, out: '', err: 'error: lease-held' }, 'tab-A1', 'tab-B1');
    expect(anonymous.ok).toBe(false);
    expect(anonymous.measured).toContain('does not name tab-A1');
  });

  it('summarize: one line per result, and the verdict is PASS only with no failure', () => {
    const results = [
      { status: 'pass', id: 'a', what: 'first' },
      { status: 'skip', id: 'bash-guard', why: 'no path' },
    ];
    const { lines, pass } = checks.summarize(results);
    expect(lines).toEqual(['PASS a — first', 'SKIP bash-guard — no path', 'ACCEPTANCE=PASS checks=2 passed=1 failed=0 skipped=1']);
    expect(pass).toBe(true);
    const failed = checks.summarize([...results, { status: 'fail', id: 'b', what: 'w', measured: 'm', expected: 'e' }]);
    expect(failed.lines).toContain('FAIL b — w — measured: m — expected: e');
    expect(failed.pass).toBe(false);
  });

  it('summarize: a skipped bash-guard check fails when it is required, and an empty run never passes', () => {
    const skipped = [{ status: 'skip', id: 'bash-guard', why: 'no path' }];
    expect(checks.summarize(skipped, { requireBashGuard: true }).pass).toBe(false);
    expect(checks.summarize([]).pass).toBe(false);
  });

  it('shellQuote leaves plain words alone and quotes the rest, including single quotes', () => {
    expect(checks.shellQuote('/usr/bin/node')).toBe('/usr/bin/node');
    expect(checks.shellQuote('merge:acc/race-1')).toBe('merge:acc/race-1');
    expect(checks.shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(checks.shellQuote('a b')).toBe(`'a b'`);
  });

  it('parseArgs requires a state file and rejects unknown flags', () => {
    expect(checks.parseArgs(['--state', 's.json', '--bash-guard', 'g.py', '--require-bash-guard'])).toEqual({
      state: 's.json',
      bashGuard: 'g.py',
      requireBashGuard: true,
    });
    expect(() => checks.parseArgs([])).toThrow(/usage/);
    expect(() => checks.parseArgs(['--state', 's', '--nope'])).toThrow(/unknown argument/);
  });

  it('refuses a state file that is not an isolated-instance state, with exit 2', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-state-'));
    fs.writeFileSync(path.join(dir, 's.json'), '{"home":"/home/x"}');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/acceptance/checks.cjs'), '--state', path.join(dir, 's.json')], { encoding: 'utf-8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSED STATE');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('isolated-instance.sh safety', { timeout: 60_000 }, () => {
  let root: string;
  let parent: string;
  let candidate: string;
  let home: string;
  const children: number[] = [];

  const built = (dir: string) => {
    for (const f of ['server.ts', 'bin/purplemux.js', 'node_modules/.bin/tsx', '.next/BUILD_ID']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
    }
  };

  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    ACCEPT_NODE: process.execPath,
    ACCEPT_SCRATCH_PARENT: parent,
    ...extra,
  });

  const instance = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync('bash', [INSTANCE, ...args], { env: asEnv(env(extra)), encoding: 'utf-8', timeout: 30_000 });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-inst-'));
    parent = path.join(root, 's');
    candidate = path.join(root, 'candidate');
    home = path.join(root, 'home');
    for (const d of [parent, candidate, path.join(home, '.purplemux')]) fs.mkdirSync(d, { recursive: true });
  });

  afterEach(() => {
    for (const pid of children.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses an unbuilt candidate before creating anything', () => {
    built(candidate);
    fs.rmSync(path.join(candidate, '.next'), { recursive: true });
    const r = instance(['up', '--candidate', candidate, '--state', path.join(root, 'state.json')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSED CANDIDATE-UNBUILT');
    expect(r.stderr).toContain('.next/BUILD_ID');
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('refuses a socket path over the unix limit and removes its scratch directory', () => {
    built(candidate);
    const deep = path.join(parent, 'x'.repeat(90));
    fs.mkdirSync(deep);
    const r = instance(['up', '--candidate', candidate, '--state', path.join(root, 'state.json')], { ACCEPT_SCRATCH_PARENT: deep });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSED SOCKET-PATH-LONG');
    expect(fs.readdirSync(deep)).toEqual([]);
  });

  it('refuses the live port and a port that answers', () => {
    built(candidate);
    fs.writeFileSync(path.join(home, '.purplemux', 'port'), '8022\n');
    const live = instance(['up', '--candidate', candidate, '--state', path.join(root, 'state.json'), '--port', '8022']);
    expect(live.status).toBe(2);
    expect(live.stderr).toContain('REFUSED LIVE-PORT');
    const fakeCurl = path.join(root, 'curl');
    fs.writeFileSync(fakeCurl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const busy = instance(['up', '--candidate', candidate, '--state', path.join(root, 'state.json'), '--port', '18123'], { ACCEPT_CURL: fakeCurl });
    expect(busy.status).toBe(2);
    expect(busy.stderr).toContain('REFUSED PORT-BUSY');
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('refuses a missing node', () => {
    built(candidate);
    const r = instance(['up', '--candidate', candidate, '--state', path.join(root, 'state.json')], { ACCEPT_NODE: path.join(root, 'no-node') });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSED NODE-MISSING');
  });

  it('down stops only processes started with the scratch HOME, and removes the scratch directory', async () => {
    const scratch = fs.mkdtempSync(path.join(parent, 'pmxa.'));
    const scratchHome = path.join(scratch, 'home');
    fs.mkdirSync(scratchHome);
    const ours = spawn('sleep', ['60'], { env: asEnv({ PATH: '/usr/bin:/bin', HOME: scratchHome }), stdio: 'ignore' });
    const live = spawn('sleep', ['60'], { env: asEnv({ PATH: '/usr/bin:/bin', HOME: home }), stdio: 'ignore' });
    children.push(ours.pid!, live.pid!);
    const oursExited = new Promise<NodeJS.Signals | null>((resolve) => ours.on('exit', (_code, signal) => resolve(signal)));
    const state = path.join(root, 'state.json');
    fs.writeFileSync(
      state,
      JSON.stringify({ scratch, home: scratchHome, tmuxTmpdir: path.join(scratch, 'tmux'), pid: live.pid, lockPid: ours.pid }),
    );
    const r = instance(['down', '--state', state]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(`NOT-OURS pid ${live.pid}`);
    expect(live.exitCode).toBeNull();
    expect(fs.existsSync(`/proc/${live.pid}`)).toBe(true);
    expect(await oursExited).toBe('SIGTERM');
    expect(fs.existsSync(scratch)).toBe(false);
  });

  it('down refuses a state file whose paths are not a scratch directory', () => {
    const state = path.join(root, 'state.json');
    fs.writeFileSync(state, JSON.stringify({ scratch: home, home: path.join(home, 'home'), tmuxTmpdir: path.join(home, 'tmux') }));
    const r = instance(['down', '--state', state]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSED STATE');
    expect(fs.existsSync(home)).toBe(true);
  });
});

describe('run.sh verdicts', { timeout: 60_000 }, () => {
  let root: string;

  const fake = (name: string, body: string) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    return file;
  };

  const runGate = (opts: { up?: number; checks?: number; live?: string[] } = {}) => {
    const instance = fake(
      'instance',
      `echo "$*" >> "${root}/instance.log"
if [[ "$1" == up ]]; then
  while (($#)); do [[ "$1" == --state ]] && state="$2"; shift; done
  echo '{"workspaces":{"a":"ws-A","b":"ws-B"}}' > "$state"
  exit ${opts.up ?? 0}
fi
exit 0`,
    );
    const checksScript = path.join(root, 'checks.cjs');
    fs.writeFileSync(checksScript, `console.log('PASS x — fake'); process.exit(${opts.checks ?? 0});\n`);
    const tmux = fake('tmux', `printf '%s\\n' ${(opts.live ?? ['pt-ws-live-p-tab-1']).map((s) => `'${s}'`).join(' ')}`);
    const log = path.join(root, 'gate.log');
    const r = spawnSync('bash', [RUN, '--candidate', root, '--log', log], {
      env: asEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, TMPDIR: root, ACCEPT_INSTANCE: instance, ACCEPT_CHECKS: checksScript, ACCEPT_TMUX: tmux, ACCEPT_NODE: process.execPath }),
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { status: r.status, out: r.stdout, log: fs.readFileSync(log, 'utf-8'), calls: fs.readFileSync(path.join(root, 'instance.log'), 'utf-8') };
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-run-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes when every check passes and nothing leaked, and always takes the instance down', () => {
    const r = runGate();
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain('PASS live-socket-untouched');
    expect(r.log).toMatch(/^ACCEPTANCE=PASS log=/m);
    expect(r.calls).toMatch(/^up --candidate /m);
    expect(r.calls).toMatch(/^down --state /m);
  });

  it('fails when a check fails, still taking the instance down', () => {
    const r = runGate({ checks: 1 });
    expect(r.status).toBe(1);
    expect(r.log).toMatch(/^ACCEPTANCE=FAIL checks_exit=1 leaked=no/m);
    expect(r.calls).toMatch(/^down /m);
  });

  it('fails when an isolated session appears on the live tmux socket', () => {
    const r = runGate({ live: ['pt-ws-live-p-tab-1', 'pt-ws-B-pane-x-tab-y'] });
    expect(r.status).toBe(1);
    expect(r.log).toContain('FAIL live-socket-untouched');
    expect(r.log).toContain('pt-ws-B-pane-x-tab-y');
    expect(r.log).toMatch(/leaked=yes/);
  });

  it('reports REFUSED with exit 2 when the instance cannot start, and never calls down', () => {
    const r = runGate({ up: 2 });
    expect(r.status).toBe(2);
    expect(r.log).toMatch(/^ACCEPTANCE=REFUSED /m);
    expect(r.calls).not.toMatch(/^down /m);
  });
});

// The real thing, against a built candidate: ACCEPTANCE_E2E_CANDIDATE=<built checkout>.
const E2E = process.env.ACCEPTANCE_E2E_CANDIDATE;
describe.skipIf(!E2E)('acceptance end to end (opt-in)', () => {
  it('passes every wave-1 and story-15 check on an isolated instance', { timeout: 600_000 }, () => {
    const log = path.join(os.tmpdir(), `acceptance-e2e-${process.pid}.log`);
    const r = spawnSync('bash', [RUN, '--candidate', E2E!, '--log', log], { encoding: 'utf-8', timeout: 590_000 });
    expect(r.status, fs.readFileSync(log, 'utf-8')).toBe(0);
    const body = fs.readFileSync(log, 'utf-8');
    // Without --bash-guard the guard check is the one SKIP; every other check must pass.
    expect(body).toMatch(/^ACCEPTANCE=PASS checks=20 passed=19 failed=0 skipped=1$/m);
    expect(body.match(/^SKIP .*/gm)).toEqual(['SKIP bash-guard — no --bash-guard path given']);
  });
});
