import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMOTE_TRUST_SEED_RELATIVE, REMOTE_TRUST_SEED_SCRIPT, remoteTrustSeedLine } from '@/lib/remote-kit';

// D14 (story 05 AC 2): the remote half of the pre-trust, run for real against a fake remote host: a
// temporary HOME holding the remote user's ~/.claude.json, and the python3 a pool host has.

const TRUSTED = { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true };

describe('the remote trust-seed script (story 05 AC 2)', () => {
  let home: string;
  let kit: string;
  let workspace: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-remote-home-')));
    kit = path.join(home, '.purplemux-remote', 'mdserver1');
    fs.mkdirSync(kit, { recursive: true });
    fs.writeFileSync(path.join(kit, REMOTE_TRUST_SEED_RELATIVE), REMOTE_TRUST_SEED_SCRIPT);
    workspace = path.join(home, 'code', 'purplemux');
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const seed = (cwd: string, workspaceDirectory = workspace) =>
    spawnSync('python3', [path.join(kit, REMOTE_TRUST_SEED_RELATIVE), cwd, workspaceDirectory], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
  const config = () => JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'));

  it('pre-trusts a worktree at its cwd and git root, keeps the rest of the file, and leaves no temporary', () => {
    const worktree = path.join(workspace, '.worktrees', 'hfl2-05');
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: x\n');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'é@x' }, projects: { '/other': { allowedTools: ['Bash'] } } }));

    expect(seed(path.join(worktree, 'src')).status).toBe(0);

    const written = config();
    expect(written.oauthAccount).toEqual({ emailAddress: 'é@x' });
    expect(written.projects['/other']).toEqual({ allowedTools: ['Bash'] });
    expect(written.projects[path.join(worktree, 'src')]).toEqual(TRUSTED);
    expect(written.projects[worktree]).toEqual(TRUSTED);
    expect(fs.statSync(path.join(home, '.claude.json')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home).filter((name) => name.startsWith('.claude.json.'))).toEqual([]);
  });

  it('writes the main repository root of a real worktree layout too: where Claude keys the imports approval', () => {
    const worktree = path.join(workspace, '.worktrees', 'wt');
    fs.mkdirSync(path.join(workspace, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${workspace}/.git/worktrees/wt\n`);

    expect(seed(worktree).status).toBe(0);

    expect(Object.keys(config().projects).sort()).toEqual([workspace, worktree].sort());
    expect(config().projects[workspace]).toEqual(TRUSTED);
  });

  it('keeps the main repository root out when it is outside the workspace directory', () => {
    const repo = path.join(home, 'repo');
    const worktree = path.join(workspace, 'wt');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${repo}/.git/worktrees/wt\n`);

    expect(seed(worktree, worktree).status).toBe(0);

    expect(Object.keys(config().projects)).toEqual([worktree]);
  });

  it('keeps an imports decline and still sets the trust (consult ruling, case 7)', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [workspace]: {
      hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true, lastSessionId: 's',
    } } }));

    expect(seed(workspace).status).toBe(0);

    expect(config().projects[workspace]).toEqual({
      hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true, lastSessionId: 's',
    });
  });

  it('replaces a default-filled triple', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [workspace]: {
      hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
    } } }));
    expect(seed(workspace).status).toBe(0);
    expect(config().projects[workspace]).toEqual(TRUSTED);
  });

  it('leaves a file that needs no change untouched, byte for byte', () => {
    const before = JSON.stringify({ projects: { [workspace]: TRUSTED } });
    fs.writeFileSync(path.join(home, '.claude.json'), before);
    expect(seed(workspace).status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8')).toBe(before);
  });

  it('creates the file on a host that has none', () => {
    expect(seed(workspace).status).toBe(0);
    expect(config()).toEqual({ projects: { [workspace]: TRUSTED } });
  });

  it('refuses a cwd outside the workspace directory (exit 3) and writes nothing', () => {
    const outside = path.join(home, 'portfolio');
    fs.mkdirSync(outside);
    expect(seed(outside).status).toBe(3);
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    expect(seed(`${workspace}-sibling`).status).toBe(3);
  });

  // Review r1 BLOCK: the real path decides, here as in workspace-trust.ts.
  it('seeds nothing for a symlink inside the workspace that points out of it (exit 3)', () => {
    const outside = path.join(home, 'elsewhere');
    fs.mkdirSync(path.join(outside, '.git'), { recursive: true });
    fs.symlinkSync(outside, path.join(workspace, 'link'));
    expect(seed(path.join(workspace, 'link')).status).toBe(3);
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
  });

  it('seeds nothing for <ws>/link/.. when the link points out (exit 3)', () => {
    const outside = path.join(home, 'far', 'away');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(workspace, 'link'));
    expect(seed(`${workspace}/link/..`).status).toBe(3);
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
  });

  it('still seeds through a symlinked workspace directory, at both spellings of the cwd', () => {
    const real = path.join(home, 'real-ws');
    fs.mkdirSync(path.join(real, 'sub'), { recursive: true });
    const link = path.join(home, 'linked-ws');
    fs.symlinkSync(real, link);
    expect(seed(path.join(link, 'sub'), link).status).toBe(0);
    expect(Object.keys(config().projects).sort()).toEqual([path.join(link, 'sub'), path.join(real, 'sub')].sort());
  });

  it('never writes a main repository root whose real path leaves the workspace through a symlink', () => {
    const realRepo = path.join(home, 'outside-repo');
    fs.mkdirSync(path.join(realRepo, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(realRepo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    fs.symlinkSync(realRepo, path.join(workspace, 'repo-link'));
    const worktree = path.join(workspace, 'wt');
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${workspace}/repo-link/.git/worktrees/wt\n`);
    expect(seed(worktree).status).toBe(0);
    expect(Object.keys(config().projects)).toEqual([worktree]);
  });

  it('never climbs past the workspace directory to a git root above it', () => {
    const inner = path.join(workspace, 'packages');
    fs.mkdirSync(path.join(inner, 'a'), { recursive: true });
    expect(seed(path.join(inner, 'a'), inner).status).toBe(0);
    expect(Object.keys(config().projects)).toEqual([path.join(inner, 'a')]);
  });

  it('leaves an unreadable file as it is (exit 4)', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), '{ half a file');
    expect(seed(workspace).status).toBe(4);
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8')).toBe('{ half a file');
  });

  it('a seed that fails, or a host without python3, never stops the create script', () => {
    const run = (script: string, pathEnv: string) => execFileSync('/bin/sh', ['-c', script], { env: { ...process.env, HOME: home, PATH: pathEnv }, encoding: 'utf-8' });
    const line = remoteTrustSeedLine({ cwd: workspace, workspaceDirectories: [workspace], named: false });
    fs.writeFileSync(path.join(kit, REMOTE_TRUST_SEED_RELATIVE), 'import sys\nsys.exit(1)\n');
    expect(run(`set -e\nd="${kit}"\n${line}\necho created`, process.env.PATH ?? '')).toBe('created\n');
    const noPython = fs.mkdtempSync(path.join(home, 'bin-'));
    expect(run(`set -e\nd="${kit}"\n${line}\necho created`, noPython)).toBe('created\n');
  });

  it('quotes the cwd and the workspace directory for the remote shell', () => {
    expect(remoteTrustSeedLine({ cwd: "/srv/it's here", workspaceDirectories: ['/srv'], named: false }))
      .toBe(`if command -v python3 >/dev/null 2>&1; then python3 "$d/trust-seed.py" '/srv/it'\\''s here' '/srv' >/dev/null 2>&1 || :; fi`);
    expect(remoteTrustSeedLine({ cwd: '/srv/a', workspaceDirectories: ['/w1', '/w2'], named: true }))
      .toBe(`if command -v python3 >/dev/null 2>&1; then python3 "$d/trust-seed.py" '--named' '/srv/a' '/w1' '/w2' >/dev/null 2>&1 || :; fi`);
  });
});

// vel-PMX-FU, consult ruling C: a remote tab create pre-trusts the cwd its creator named, on the host, outside every
// workspace directory: the trust key on the cwd only, the CLAUDE.md-include keys on its main repository root, and
// hard refusals for a cwd whose trust would cover the home or the whole disk. Run for real against a fake home.
describe('the named cwd pre-trust (vel-PMX-FU)', () => {
  const INCLUDES = { hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true };
  let root: string;
  let home: string;
  let kit: string;
  let workspace: string;

  beforeEach(() => {
    // Nested, so the home has an ancestor that is not a top-level directory.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-named-')));
    home = path.join(root, 'users', 'user');
    kit = path.join(home, '.purplemux-remote', 'control-host');
    fs.mkdirSync(kit, { recursive: true });
    fs.writeFileSync(path.join(kit, REMOTE_TRUST_SEED_RELATIVE), REMOTE_TRUST_SEED_SCRIPT);
    workspace = path.join(home, 'code', 'workspace-dir');
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const seed = (args: string[]) =>
    spawnSync('python3', [path.join(kit, REMOTE_TRUST_SEED_RELATIVE), ...args], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
  const configFile = () => path.join(home, '.claude.json');
  const projects = () => JSON.parse(fs.readFileSync(configFile(), 'utf-8')).projects ?? {};

  it('outside every workspace directory: the trust key on the cwd only, the include keys on the repository root', () => {
    const repo = path.join(home, 'elsewhere', 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(configFile(), JSON.stringify({ oauthAccount: { id: 'kept' }, projects: { '/other': { allowedTools: ['Bash'] } } }));

    expect(seed(['--named', path.join(repo, 'src'), workspace]).status).toBe(0);

    const written = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
    expect(written.oauthAccount).toEqual({ id: 'kept' });
    expect(written.projects).toEqual({
      '/other': { allowedTools: ['Bash'] },
      [path.join(repo, 'src')]: TRUSTED,
      [repo]: INCLUDES,
    });
    expect(fs.statSync(configFile()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home).filter((name) => name.startsWith('.claude.json.'))).toEqual([]);
  });

  it('a linked worktree outside the workspace: trust on the worktree, the include keys on its main checkout; both spellings of a link', () => {
    const main = path.join(home, 'clones', 'main');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const worktree = path.join(home, 'trees', 'wt');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${main}/.git/worktrees/wt\n`);
    const link = path.join(home, 'link-to-wt');
    fs.symlinkSync(worktree, link);

    expect(seed(['--first-run', '--named', link]).status).toBe(0);

    const onboarded = { ...TRUSTED, hasCompletedProjectOnboarding: true };
    expect(projects()).toEqual({
      [link]: onboarded,
      [worktree]: onboarded,
      [main]: { ...INCLUDES, hasCompletedProjectOnboarding: true },
    });
  });

  it('a cwd inside a workspace directory still takes the D14 rule under --named', () => {
    fs.mkdirSync(path.join(workspace, 'src'));
    expect(seed(['--named', path.join(workspace, 'src'), workspace]).status).toBe(0);
    expect(projects()).toEqual({ [path.join(workspace, 'src')]: TRUSTED, [workspace]: TRUSTED });
  });

  it('refuses a cwd whose trust would cover the home or the disk (exit 6) and a missing one (exit 5), writing no project key', () => {
    fs.symlinkSync('/', path.join(home, 'to-root'));
    fs.symlinkSync(home, path.join(root, 'to-home'));
    fs.mkdirSync(path.join(home, 'x'));
    const cases: Array<[string, number]> = [
      ['/', 6],
      [path.parse(root).root + root.split(path.sep)[1], 6],
      [home, 6],
      [path.dirname(home), 6],
      [path.join(home, 'to-root'), 6],
      [path.join(root, 'to-home'), 6],
      [`${home}/x/..`, 6],
      [path.join(home, 'no-such-dir'), 5],
    ];
    for (const [cwd, code] of cases) {
      expect(seed(['--named', cwd]).status, cwd).toBe(code);
      expect(fs.existsSync(configFile()), cwd).toBe(false);
    }
    fs.writeFileSync(configFile(), '{"keep": 1}');
    for (const [cwd, code] of cases) {
      expect(seed(['--named', cwd]).status, cwd).toBe(code);
      expect(fs.readFileSync(configFile(), 'utf-8'), cwd).toBe('{"keep": 1}');
    }
    for (const [cwd, code] of cases) {
      expect(seed(['--first-run', '--named', cwd]).status, cwd).toBe(code);
      const written = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
      expect(written.projects ?? {}, cwd).toEqual({});
      expect(written.hasCompletedOnboarding, cwd).toBe(true);
    }
  });

  it('a dotfiles repository in the home: the cwd keys only, nothing at the home', () => {
    fs.mkdirSync(path.join(home, '.git'));
    fs.mkdirSync(path.join(home, 'proj'));
    expect(seed(['--named', path.join(home, 'proj')]).status).toBe(0);
    expect(projects()).toEqual({ [path.join(home, 'proj')]: TRUSTED });
  });

  it('no widening without --named: an empty workspace list still exits 3 and writes nothing', () => {
    const repo = path.join(home, 'elsewhere', 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    expect(seed([repo]).status).toBe(3);
    expect(fs.existsSync(configFile())).toBe(false);
    expect(seed(['--named']).status).toBe(2);
  });
});
