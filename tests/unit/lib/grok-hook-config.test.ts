import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GROK_HOOK_EVENTS,
  GrokSettingsUnreadableError,
  ensureGrokHookSettings,
  mergeGrokHookSettings,
} from '@/lib/providers/grok/hook-config';

const SCRIPT = '/home/dev/.purplemux/grok-hook.sh';

const dirs: string[] = [];

const tmpSettings = (contents?: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-grok-settings-'));
  dirs.push(dir);
  const target = path.join(dir, 'user-settings.json');
  if (contents !== undefined) fs.writeFileSync(target, contents);
  return target;
};

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('mergeGrokHookSettings', () => {
  it('adds every purplemux event to an empty settings file', () => {
    const { settings, changed } = mergeGrokHookSettings(null, SCRIPT);
    const hooks = settings.hooks as Record<string, unknown[]>;

    expect(changed).toBe(true);
    expect(Object.keys(hooks).sort()).toEqual([...GROK_HOOK_EVENTS].sort());
    expect(hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: `sh "${SCRIPT}" Stop`, timeout: 3 }] },
    ]);
  });

  it('leaves PostToolUse unmatched because grok matches a matcher by exact equality', () => {
    const { settings } = mergeGrokHookSettings(null, SCRIPT);
    const entries = (settings.hooks as Record<string, Array<{ matcher?: string }>>).PostToolUse;
    expect(entries[0].matcher).toBeUndefined();
  });

  it('preserves the user keys and their own hooks', () => {
    const existing = {
      apiKey: 'xai-secret',
      defaultModel: 'grok-4.20',
      subAgents: [{ name: 'reviewer', model: 'grok-4.20' }],
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'notify-send hi' }] }],
      },
    };

    const { settings } = mergeGrokHookSettings(existing, SCRIPT);
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;

    expect(settings.apiKey).toBe('xai-secret');
    expect(settings.subAgents).toEqual(existing.subAgents);
    expect(hooks.SubagentStop).toEqual(existing.hooks.SubagentStop);
    expect(hooks.Stop.map((entry) => entry.hooks[0].command)).toEqual([
      'say done',
      `sh "${SCRIPT}" Stop`,
    ]);
  });

  it('is idempotent — a second merge neither duplicates nor reports a change', () => {
    const first = mergeGrokHookSettings({ apiKey: 'xai-secret' }, SCRIPT);
    const second = mergeGrokHookSettings(first.settings, SCRIPT);

    expect(second.changed).toBe(false);
    expect(second.settings).toEqual(first.settings);
  });

  it('replaces a stale purplemux entry rather than stacking a second one', () => {
    const stale = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `sh "${SCRIPT}" stop`, timeout: 9 }] }] },
    };
    const { settings } = mergeGrokHookSettings(stale, SCRIPT);
    const entries = (settings.hooks as Record<string, unknown[]>).Stop;

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ hooks: [{ type: 'command', command: `sh "${SCRIPT}" Stop`, timeout: 3 }] });
  });

  it('keeps an element it cannot parse and installs its own entry beside it', () => {
    const { settings } = mergeGrokHookSettings({ hooks: { Stop: ['nonsense', 42] } }, SCRIPT);
    const entries = (settings.hooks as Record<string, unknown[]>).Stop;

    expect(entries).toEqual([
      'nonsense',
      42,
      { hooks: [{ type: 'command', command: `sh "${SCRIPT}" Stop`, timeout: 3 }] },
    ]);
  });

  it('keeps a hook value that is not an array at all', () => {
    const existing = {
      apiKey: 'xai-secret',
      hooks: {
        PostToolUse: { matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] },
        Stop: 'run-my-script',
      },
    };
    const before = JSON.stringify(existing);

    const { settings } = mergeGrokHookSettings(existing, SCRIPT);
    const hooks = settings.hooks as Record<string, unknown>;

    expect(JSON.stringify(existing)).toBe(before);
    expect(hooks.PostToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] },
      { hooks: [{ type: 'command', command: `sh "${SCRIPT}" PostToolUse`, timeout: 3 }] },
    ]);
    expect(hooks.Stop).toEqual([
      'run-my-script',
      { hooks: [{ type: 'command', command: `sh "${SCRIPT}" Stop`, timeout: 3 }] },
    ]);
    expect(settings.apiKey).toBe('xai-secret');
  });

  it('leaves an event purplemux does not write exactly as it found it', () => {
    const { settings } = mergeGrokHookSettings(
      { hooks: { SubagentStop: [{ weird: true }], PreToolUse: { legacy: 'shape' } } },
      SCRIPT,
    );
    const hooks = settings.hooks as Record<string, unknown>;

    expect(hooks.SubagentStop).toEqual([{ weird: true }]);
    expect(hooks.PreToolUse).toEqual({ legacy: 'shape' });
  });

  it('stays idempotent over settings it could not parse', () => {
    const first = mergeGrokHookSettings({ hooks: { Stop: ['nonsense'], SubagentStop: 'mine' } }, SCRIPT);
    const second = mergeGrokHookSettings(first.settings, SCRIPT);

    expect(second.changed).toBe(false);
    expect(second.settings).toEqual(first.settings);
  });
});

describe('ensureGrokHookSettings', () => {
  it('creates the settings file at 0600 and reports the write', async () => {
    const target = tmpSettings();
    expect(await ensureGrokHookSettings(SCRIPT, target)).toBe(true);

    const written = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(Object.keys(written.hooks).sort()).toEqual([...GROK_HOOK_EVENTS].sort());
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it('does not rewrite a file that already carries the block', async () => {
    const target = tmpSettings(JSON.stringify({ apiKey: 'xai-secret' }));
    expect(await ensureGrokHookSettings(SCRIPT, target)).toBe(true);
    expect(await ensureGrokHookSettings(SCRIPT, target)).toBe(false);
    expect(JSON.parse(fs.readFileSync(target, 'utf-8')).apiKey).toBe('xai-secret');
  });

  it('refuses to overwrite an unparseable settings file', async () => {
    const target = tmpSettings('{ this is not json');
    await expect(ensureGrokHookSettings(SCRIPT, target)).rejects.toBeInstanceOf(GrokSettingsUnreadableError);
    expect(fs.readFileSync(target, 'utf-8')).toBe('{ this is not json');
  });
});
