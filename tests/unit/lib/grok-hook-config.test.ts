import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GROK_HOOK_FILE_NAME,
  GROK_NOTIFICATION_MATCHER,
  GROK_TOOL_MATCHER,
  buildGrokHookConfig,
  writeGrokHookFile,
} from '@/lib/providers/grok/hook-config';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

const SCRIPT = '/home/dev/.purplemux/grok-hook.sh';

describe('buildGrokHookConfig', () => {
  const config = buildGrokHookConfig(SCRIPT);

  it('emits the Claude hooks JSON format grok reads from $GROK_HOME/hooks/*.json', () => {
    expect(config.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: `sh "${SCRIPT}"`, timeout: 3 }] },
    ]);
  });

  it('registers the five events a complete busy/idle indicator needs', () => {
    for (const event of ['UserPromptSubmit', 'Stop', 'StopFailure', 'StopCancelled', 'Notification']) {
      expect(config.hooks[event]).toBeDefined();
    }
  });

  it('matches only the notification types a host UI acts on', () => {
    expect(config.hooks.Notification[0].matcher).toBe(GROK_NOTIFICATION_MATCHER);
    expect(GROK_NOTIFICATION_MATCHER.split('|')).toEqual(['permission_prompt', 'idle_prompt', 'task_complete']);
  });

  it('matches both grok\'s own tool names and the Claude names they alias', () => {
    expect(config.hooks.PostToolUse[0].matcher).toBe(GROK_TOOL_MATCHER);
    expect(GROK_TOOL_MATCHER).toContain('search_replace');
    expect(GROK_TOOL_MATCHER).toContain('run_terminal_command');
    expect(GROK_TOOL_MATCHER).toContain('Bash');
  });

  it('does not register a blocking gate — every handler is observe-only', () => {
    const commands = Object.values(config.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));
    expect(commands.every((hook) => hook.type === 'command' && hook.command === `sh "${SCRIPT}"`)).toBe(true);
  });
});

describe('writeGrokHookFile', () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-home-'));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const hookFile = () => path.join(home, 'hooks', GROK_HOOK_FILE_NAME);

  it('creates the hooks directory and writes owner-only', async () => {
    expect(await writeGrokHookFile(home, SCRIPT)).toBe(true);

    const stat = await fs.stat(hookFile());
    expect(stat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(hookFile(), 'utf-8'))).toEqual(buildGrokHookConfig(SCRIPT));
  });

  it('is idempotent — an unchanged boot does not rewrite the file', async () => {
    await writeGrokHookFile(home, SCRIPT);
    expect(await writeGrokHookFile(home, SCRIPT)).toBe(false);
  });

  it('rewrites when the script path changes', async () => {
    await writeGrokHookFile(home, SCRIPT);
    expect(await writeGrokHookFile(home, '/other/grok-hook.sh')).toBe(true);
    expect(await fs.readFile(hookFile(), 'utf-8')).toContain('/other/grok-hook.sh');
  });

  it('never touches another hook file in the same directory', async () => {
    const sibling = path.join(home, 'hooks', 'user-guard.json');
    await fs.mkdir(path.dirname(sibling), { recursive: true });
    await fs.writeFile(sibling, '{"hooks":{"PreToolUse":[]}}');

    await writeGrokHookFile(home, SCRIPT);

    expect(await fs.readFile(sibling, 'utf-8')).toBe('{"hooks":{"PreToolUse":[]}}');
    expect((await fs.readdir(path.join(home, 'hooks'))).sort()).toEqual([GROK_HOOK_FILE_NAME, 'user-guard.json']);
  });
});

describe('ensureGrokHookFiles', () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-grok-hooks-'));
    mockHome.value = home;
    vi.resetModules();
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('installs into the unscoped home and into every workspace home', async () => {
    await fs.mkdir(path.join(home, '.grok'), { recursive: true });
    const { ensureWorkspaceGrokHome } = await import('@/lib/grok-home');
    const wsHome = await ensureWorkspaceGrokHome('ws-hooks');
    const { ensureGrokHookFiles } = await import('@/lib/providers/grok/hook-config');

    const written = await ensureGrokHookFiles(SCRIPT);

    expect(written.sort()).toEqual([path.join(home, '.grok'), wsHome].sort());
    for (const target of written) {
      expect(JSON.parse(await fs.readFile(path.join(target, 'hooks', GROK_HOOK_FILE_NAME), 'utf-8')))
        .toEqual(buildGrokHookConfig(SCRIPT));
    }
  });

  it('writes nothing the second time when neither home changed', async () => {
    await fs.mkdir(path.join(home, '.grok'), { recursive: true });
    const { ensureGrokHookFiles } = await import('@/lib/providers/grok/hook-config');

    await ensureGrokHookFiles(SCRIPT);
    expect(await ensureGrokHookFiles(SCRIPT)).toEqual([]);
  });
});

/**
 * The generated script runs on grok's critical path: a `Stop` hook that blocks
 * or exits non-zero keeps the agent working.
 */
describe('the generated grok-hook.sh', () => {
  it('forwards the camelCase stdin body to the grok branch of the hook route', async () => {
    const { GROK_HOOK_SCRIPT_CONTENT } = await import('@/lib/hook-settings');

    expect(GROK_HOOK_SCRIPT_CONTENT).toContain('/api/status/hook?provider=grok&tmuxSession=');
    expect(GROK_HOOK_SCRIPT_CONTENT).toContain('x-pmux-token');
    expect(GROK_HOOK_SCRIPT_CONTENT).toContain('BODY=$(cat)');
    expect(GROK_HOOK_SCRIPT_CONTENT).toContain('--data-binary @-');
  });

  it('detaches, time-boxes the request and always exits 0', async () => {
    const { GROK_HOOK_SCRIPT_CONTENT } = await import('@/lib/hook-settings');

    expect(GROK_HOOK_SCRIPT_CONTENT).toContain('--max-time 2');
    expect(GROK_HOOK_SCRIPT_CONTENT).toMatch(/>\/dev\/null 2>&1 &\n/);
    expect(GROK_HOOK_SCRIPT_CONTENT.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('reports the event grok injects even when stdin arrives empty', async () => {
    const { GROK_HOOK_SCRIPT_CONTENT } = await import('@/lib/hook-settings');

    expect(GROK_HOOK_SCRIPT_CONTENT).toContain('${GROK_HOOK_EVENT}');
    expect(GROK_HOOK_SCRIPT_CONTENT).toContain("[ -z \"$BODY\" ] && BODY='{}'");
  });
});
