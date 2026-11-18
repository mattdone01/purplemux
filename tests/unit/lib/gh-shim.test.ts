import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ghBashEnvPath,
  ghPathExecPath,
  ghShimDir,
  ghShimLaunchPrefix,
  ghShimPaneEnv,
  ghShimPath,
  ghShimScript,
  installGhShim,
  installedGhShimDir,
  resolveRealGh,
} from '@/lib/gh-shim';
import { LOGIN_SHELL_BASE_PATH } from '@/lib/shell-env';

// engineering#810 R1 (a): the gh shim on a local tab's PATH writes one line per call, and never a path or a token.

const run = promisify(execFile);

let root = '';
let fakeGh = '';
let shim = '';

const utcDay = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, '');

const writeExec = async (file: string, body: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, { mode: 0o755 });
};

const runShim = async (args: string[], env: Record<string, string> = {}) => {
  try {
    const { stdout } = await run('sh', [shim, ...args], {
      env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), XDG_STATE_HOME: path.join(root, 'state'), ...env },
    });
    return { code: 0, stdout };
  } catch (err) {
    const f = err as { code?: number; stdout?: string };
    return { code: f.code ?? -1, stdout: f.stdout ?? '' };
  }
};

const logFile = () => path.join(root, 'state', 'purplemux', 'gh-calls', `${utcDay()}.log`);
const logLines = async (): Promise<string[]> => (await fs.readFile(logFile(), 'utf-8')).split('\n').filter(Boolean);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-gh-shim-'));
  fakeGh = path.join(root, 'real', 'gh');
  await writeExec(fakeGh, '#!/bin/sh\necho "real:$*"\nexit 7\n');
  shim = path.join(root, 'shim', 'gh');
  await writeExec(shim, ghShimScript(fakeGh));
});

afterEach(async () => {
  await fs.chmod(path.join(root, 'state'), 0o700).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
});

describe('the gh shim script', () => {
  it('writes one line per call with the tab, the workspace and the two allowed words, then runs the real gh', async () => {
    const r = await runShim(['pr', 'checks', '12', '--repo', 'o/r'], { PMUX_TAB_ID: 'tab-a1', PMUX_WORKSPACE_ID: 'ws-B_2' });
    expect(r.stdout).toBe('real:pr checks 12 --repo o/r\n');
    const lines = await logLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{10} tab-a1 ws-B_2 pr checks$/);
    const epoch = Number(lines[0].split(' ')[0]);
    expect(Math.abs(epoch * 1000 - Date.now())).toBeLessThan(60_000);
  });

  it('keeps the real gh exit code', async () => {
    expect((await runShim(['run', 'list'])).code).toBe(7);
  });

  it('for gh api records the kind only, never the path, the query or a token', async () => {
    await runShim(['api', 'repos/x?token=ghp_SECRET']);
    await runShim(['api', 'graphql', '-f', 'query=query { viewer { login } } ghp_SECRET']);
    await runShim(['api', '-X', 'GET', 'repos/o/r/actions/jobs/1/logs?access_token=ghp_SECRET']);
    const text = await fs.readFile(logFile(), 'utf-8');
    expect(text).not.toContain('ghp_SECRET');
    expect(text).not.toContain('repos');
    expect(text).not.toContain('viewer');
    expect((await logLines()).map((l) => l.split(' ').slice(1).join(' '))).toEqual(['- - api rest', '- - api graphql', '- - api rest']);
  });

  it('writes ? for an unknown command or subcommand, and - when there is no subcommand', async () => {
    await runShim(['pr', 'ghp_SECRET']);
    await runShim(['frobnicate', 'ghp_SECRET']);
    await runShim(['--version']);
    await runShim(['pr']);
    expect((await logLines()).map((l) => l.split(' ').slice(3).join(' '))).toEqual(['pr ?', '? ?', '? ?', 'pr -']);
    expect(await fs.readFile(logFile(), 'utf-8')).not.toContain('SECRET');
  });

  it('writes - for a missing or malformed tab or workspace id', async () => {
    await runShim(['run', 'view']);
    await runShim(['run', 'view'], { PMUX_TAB_ID: 'tab a;rm', PMUX_WORKSPACE_ID: '' });
    expect((await logLines()).map((l) => l.split(' ').slice(1, 3).join(' '))).toEqual(['- -', '- -']);
  });

  it('creates the log directory 0700 and the file 0600', async () => {
    await runShim(['run', 'view']);
    expect((await fs.stat(path.join(root, 'state', 'purplemux', 'gh-calls'))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(logFile())).mode & 0o777).toBe(0o600);
  });

  it('uses $HOME/.local/state when XDG_STATE_HOME is not set', async () => {
    await runShim(['run', 'view'], { XDG_STATE_HOME: '' });
    const file = path.join(root, 'home', '.local', 'state', 'purplemux', 'gh-calls', `${utcDay()}.log`);
    expect((await fs.readFile(file, 'utf-8')).trim()).toMatch(/ run view$/);
  });

  it('still runs the real gh when the log cannot be written', async () => {
    await fs.mkdir(path.join(root, 'state'), { recursive: true });
    await fs.writeFile(path.join(root, 'state', 'purplemux'), 'not a directory');
    const r = await runShim(['pr', 'view', '3']);
    expect(r).toEqual({ code: 7, stdout: 'real:pr view 3\n' });
  });

  it('pins a real gh path that holds a quote', async () => {
    const odd = path.join(root, "it's", 'gh');
    await writeExec(odd, '#!/bin/sh\necho odd\n');
    await writeExec(shim, ghShimScript(odd));
    expect((await runShim(['run', 'list'])).stdout).toBe('odd\n');
  });
});

describe('installGhShim', () => {
  const home = () => path.join(root, 'home');

  it('resolves the real gh from PATH without the shim directory, and pins it', async () => {
    const dir = ghShimDir(home());
    await writeExec(path.join(dir, 'gh'), '#!/bin/sh\nexit 0\n');
    const pathEnv = [dir, path.join(root, 'empty'), path.dirname(fakeGh)].join(':');
    expect(await resolveRealGh(pathEnv, dir)).toBe(fakeGh);
    const result = await installGhShim({ home: home(), pathEnv });
    expect(result).toEqual({ installed: true, dir, realGh: fakeGh });
    const script = await fs.readFile(ghShimPath(home()), 'utf-8');
    expect(script).toContain(`'${fakeGh}'`);
    expect((await fs.stat(ghShimPath(home()))).mode & 0o777).toBe(0o755);
    expect((await fs.stat(ghPathExecPath(home()))).mode & 0o777).toBe(0o755);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('installs nothing, and removes an old shim, when no real gh is on PATH', async () => {
    await installGhShim({ home: home(), pathEnv: path.dirname(fakeGh) });
    expect(installedGhShimDir(home())).toBe(ghShimDir(home()));
    const result = await installGhShim({ home: home(), pathEnv: path.join(root, 'empty') });
    expect(result).toEqual({ installed: false, reason: expect.stringContaining('no gh on PATH') });
    expect(installedGhShimDir(home())).toBeNull();
    await expect(fs.stat(ghShimPath(home()))).rejects.toThrow();
  });

  it('never pins the shim itself, even through a link', async () => {
    const dir = ghShimDir(home());
    await writeExec(path.join(dir, 'gh'), '#!/bin/sh\nexit 0\n');
    const link = path.join(root, 'linkdir');
    await fs.mkdir(link);
    await fs.symlink(path.join(dir, 'gh'), path.join(link, 'gh'));
    expect(await resolveRealGh(`${link}:${path.dirname(fakeGh)}`, dir)).toBe(fakeGh);
  });
});

describe('the shim on a local tab', () => {
  const home = () => path.join(root, 'home');

  it('adds nothing when no shim is installed', () => {
    expect(installedGhShimDir(home())).toBeNull();
    expect(ghShimPaneEnv(home())).toEqual({});
    expect(ghShimLaunchPrefix(home())).toBe('');
  });

  it('puts the shim directory first on the pane PATH, before the login floor', async () => {
    await installGhShim({ home: home(), pathEnv: path.dirname(fakeGh) });
    expect(ghShimPaneEnv(home())).toEqual({ PATH: `${ghShimDir(home())}:${LOGIN_SHELL_BASE_PATH}` });
  });

  it('prefixes an agent launch with the PATH wrapper, which puts the shim first after the shell rc', async () => {
    await installGhShim({ home: home(), pathEnv: path.dirname(fakeGh) });
    const prefix = ghShimLaunchPrefix(home());
    expect(prefix).toBe(`'${ghPathExecPath(home())}' `);
    const { stdout } = await run('sh', ['-c', `${prefix}sh -c 'command -v gh'`], { env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: home() } });
    expect(stdout.trim()).toBe(ghShimPath(home()));
  });

  describe('an agent tool shell that is a login bash (the #97 CONFIRM concern)', () => {
    // The login rc puts another gh first, as ~/.profile does on the agent hosts (measured: bash -lc gave ~/.local/bin/gh).
    const rcGh = () => path.join(home(), 'rcbin', 'gh');
    const launch = async (inner: string, env: Record<string, string> = {}) => {
      await installGhShim({ home: home(), pathEnv: path.dirname(fakeGh) });
      await writeExec(rcGh(), '#!/bin/sh\necho rc-gh\n');
      await fs.writeFile(path.join(home(), '.profile'), 'PATH="$HOME/rcbin:$PATH"\nexport PATH\n');
      const { stdout } = await run('sh', ['-c', `${ghShimLaunchPrefix(home())}${inner}`], {
        env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: home(), ...env },
      });
      return stdout.trim();
    };

    it('without BASH_ENV the rc wins: the control the fix answers', async () => {
      expect(await launch(`env -u BASH_ENV bash -lc 'command -v gh'`)).toBe(rcGh());
    });

    it('bash -lc under the wrapper finds the shim first, after the rc', async () => {
      expect(await launch(`bash -lc 'command -v gh'`)).toBe(ghShimPath(home()));
    });

    it('bash -c under the wrapper finds the shim first', async () => {
      expect(await launch(`bash -c 'command -v gh'`)).toBe(ghShimPath(home()));
    });

    it('sources an earlier BASH_ENV first, and a nested launch keeps it', async () => {
      const prev = path.join(root, 'prev-env.sh');
      await fs.writeFile(prev, 'PMUX_TEST_MARK=prev\n');
      const prefix = `'${ghPathExecPath(home())}' `;
      expect(await launch(`${prefix}bash -lc 'echo "$PMUX_TEST_MARK $(command -v gh)"'`, { BASH_ENV: prev }))
        .toBe(`prev ${ghShimPath(home())}`);
    });

    it('adds the shim once when it is first already', async () => {
      const out = await launch(`bash -c 'echo "$PATH"'`);
      expect(out.split(':').filter((e) => e === ghShimDir(home()))).toHaveLength(1);
    });

    it('installs the bash-env file, and removes it with the shim', async () => {
      await installGhShim({ home: home(), pathEnv: path.dirname(fakeGh) });
      await expect(fs.access(ghBashEnvPath(home()))).resolves.toBeUndefined();
      await installGhShim({ home: home(), pathEnv: path.join(root, 'empty') });
      await expect(fs.access(ghBashEnvPath(home()))).rejects.toThrow();
      expect(installedGhShimDir(home())).toBeNull();
    });
  });
});
