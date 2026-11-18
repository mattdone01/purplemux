import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tab-token', () => ({ ensureTabToken: async () => 'tab-token-x' }));
vi.mock('@/lib/config-store', () => ({ getDangerouslySkipPermissions: vi.fn(async () => false) }));
vi.mock('@/lib/hook-settings', () => ({ HOOK_SETTINGS_PATH: '/home/u/.purplemux/hooks.json' }));
vi.mock('@/lib/claude-prompt', () => ({
  getClaudePromptPath: (wsId: string) => `/home/u/.purplemux/workspaces/${wsId}/claude-prompt.md`,
  writeClaudePromptFile: vi.fn(),
}));

vi.mock('@/lib/providers/grok/preflight', () => ({
  runGrokPreflight: async () => ({ installed: true, version: '1', binaryPath: '/opt/grok/bin/grok' }),
  checkGrokLogin: async () => true,
}));

const { tabEnv } = await import('@/lib/tmux');
const { composeGrokLaunchCommand } = await import('@/lib/providers/grok');
const { buildManagedCodexLaunchCommand } = await import('@/lib/providers/codex');
const { claudeCommand } = await import('@/lib/claude-command');
const { ghPathExecPath, ghShimDir, installGhShim } = await import('@/lib/gh-shim');
const { LOGIN_SHELL_BASE_PATH } = await import('@/lib/shell-env');

// engineering#810, consult ruling B: a local tab's pane PATH starts with the shim directory, and every local agent
// launch puts it first again after the shell's own rc.

const identity = { workspaceId: 'ws-1', tabId: 'tab-a' };

const install = async (): Promise<void> => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-real-gh-'));
  await fs.writeFile(path.join(bin, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = await installGhShim({ pathEnv: bin });
  expect(result.installed).toBe(true);
};

afterEach(async () => {
  await fs.rm(path.join(os.homedir(), '.local', 'share', 'purplemux'), { recursive: true, force: true });
});

describe('tabEnv', () => {
  it('adds no PATH when no shim is installed', async () => {
    expect(await tabEnv('pt-ws-1-pane-p-tab-a', identity)).toEqual({
      PMUX_TAB_TOKEN: 'tab-token-x', PMUX_TAB_ID: 'tab-a', PMUX_WORKSPACE_ID: 'ws-1',
    });
    expect(await tabEnv('pt-ws-1-pane-p-tab-a')).toEqual({});
  });

  it('puts the shim directory first on PATH, then the login floor, never the server PATH', async () => {
    await install();
    const env = await tabEnv('pt-ws-1-pane-p-tab-a', identity);
    expect(env.PATH).toBe(`${ghShimDir()}:${LOGIN_SHELL_BASE_PATH}`);
    expect(env.PMUX_TAB_ID).toBe('tab-a');
    expect(await tabEnv('pt-ws-1-pane-p-tab-a')).toEqual({ PATH: `${ghShimDir()}:${LOGIN_SHELL_BASE_PATH}` });
  });
});

describe('a local claude launch', () => {
  it('is unchanged without a shim', () => {
    expect(claudeCommand('--settings x')).toBe('claude --settings x');
  });

  it('starts through the PATH wrapper when the shim is installed, after an evaluator env', async () => {
    await install();
    expect(claudeCommand('--settings x')).toBe(`'${ghPathExecPath()}' claude --settings x`);
    expect(claudeCommand('--settings x', { role: 'evaluator', pgService: 'svc' })).toBe(`PGSERVICE=svc '${ghPathExecPath()}' claude --settings x`);
  });
});

describe('a local grok or codex launch', () => {
  const identity4 = { workspaceId: 'ws-1', tabId: 'tab-a', sessionName: 'pt-ws-1-pane-p-tab-a', generation: 'g1' };

  it('is unchanged without a shim', async () => {
    expect(await composeGrokLaunchCommand('s-1')).toMatch(/^'\/opt\/grok\/bin\/grok' --cwd/);
    expect(await buildManagedCodexLaunchCommand(identity4)).toMatch(/^node '/);
  });

  it('starts through the PATH wrapper when the shim is installed', async () => {
    await install();
    expect(await composeGrokLaunchCommand('s-1')).toMatch(new RegExp(`^'${ghPathExecPath()}' '/opt/grok/bin/grok' --cwd`));
    expect(await buildManagedCodexLaunchCommand(identity4)).toMatch(new RegExp(`^'${ghPathExecPath()}' node '`));
  });
});
