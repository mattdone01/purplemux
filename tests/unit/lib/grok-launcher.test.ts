import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '' }));
const state = vi.hoisted(() => ({ skipPermissions: false, binaryPath: null as string | null }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

vi.mock('@/lib/config-store', () => ({
  getDangerouslySkipPermissions: async () => state.skipPermissions,
}));

vi.mock('@/lib/providers/grok/preflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers/grok/preflight')>();
  return {
    ...actual,
    runGrokPreflight: async () => ({ installed: true, version: '1.0.4', binaryPath: state.binaryPath }),
  };
});

const importProvider = async () => {
  vi.resetModules();
  return import('@/lib/providers/grok');
};

const SESSION_ID = '01a008c1-bb96-71d1-9769-b63ff478fd9f';

beforeEach(async () => {
  mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-grok-launch-'));
  state.skipPermissions = false;
  state.binaryPath = path.join(mockHome.value, '.grok', 'bin', 'grok');
});

describe('grok launch command', () => {
  it('runs the resolved binary against the pane cwd', async () => {
    const { grokProvider } = await importProvider();

    expect(await grokProvider.buildLaunchCommand({}))
      .toBe(`'${mockHome.value}/.grok/bin/grok' --cwd "$PWD"`);
  });

  it('falls back to the install path when the binary could not be resolved', async () => {
    state.binaryPath = null;
    const { grokProvider } = await importProvider();

    expect(await grokProvider.buildLaunchCommand({}))
      .toContain(`'${mockHome.value}/.grok/bin/grok'`);
  });

  it('passes bypassPermissions only when the setting is on', async () => {
    state.skipPermissions = true;
    const { grokProvider } = await importProvider();

    expect(await grokProvider.buildLaunchCommand({})).toContain('--permission-mode bypassPermissions');
  });

  it('resumes by session id', async () => {
    const { grokProvider } = await importProvider();

    expect(await grokProvider.buildResumeCommand(SESSION_ID, {}))
      .toBe(`'${mockHome.value}/.grok/bin/grok' --cwd "$PWD" --resume '${SESSION_ID}'`);
  });

  it('never threads a GROK_HOME into the command — the pane shell exports it', async () => {
    const { grokProvider } = await importProvider();

    expect(await grokProvider.buildLaunchCommand({ workspaceId: 'ws-1' })).not.toContain('GROK_HOME');
  });

  it('refuses a resume id that is not a session id', async () => {
    const { grokProvider } = await importProvider();

    expect(() => grokProvider.buildResumeCommand('; rm -rf /', {})).toThrow(/Invalid grok session ID/);
  });
});

describe('grok login preflight', () => {
  it('reports signed in when auth.json exists', async () => {
    vi.resetModules();
    const { checkGrokLogin } = await vi.importActual<typeof import('@/lib/providers/grok/preflight')>(
      '@/lib/providers/grok/preflight',
    );
    const authPath = path.join(mockHome.value, 'auth.json');
    await fs.writeFile(authPath, '{}');

    expect(await checkGrokLogin(authPath)).toBe(true);
    expect(await checkGrokLogin(path.join(mockHome.value, 'missing.json'))).toBe(false);
  });

  it('accepts the XAI_API_KEY fallback documented for a box with no session token', async () => {
    vi.resetModules();
    const { checkGrokLogin } = await vi.importActual<typeof import('@/lib/providers/grok/preflight')>(
      '@/lib/providers/grok/preflight',
    );
    const previous = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = 'xai-test';
    try {
      expect(await checkGrokLogin(path.join(mockHome.value, 'missing.json'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previous;
    }
  });
});
