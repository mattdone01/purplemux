import fs from 'fs/promises';
import path from 'path';
import { GROK_HOME } from '@/lib/providers/grok/db';
import { createLogger } from '@/lib/logger';

const log = createLogger('grok-config');

export const GROK_USER_SETTINGS_PATH = path.join(GROK_HOME, 'user-settings.json');

/**
 * Every event purplemux needs to keep a grok tab's work state honest.
 * `PostToolUse` carries no matcher on purpose: grok matches a matcher by exact
 * string equality (`src/hooks/config.ts` `matchesPattern`), so the
 * pipe-separated tool list the Claude hook block uses would never fire.
 */
export const GROK_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'Notification',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
  'PostToolUse',
] as const;
export type TGrokHookEvent = typeof GROK_HOOK_EVENTS[number];

const HOOK_TIMEOUT_SEC = 3;

export interface IGrokHookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface IGrokHookEntry {
  matcher?: string;
  hooks: IGrokHookCommand[];
}

export type TGrokHookConfig = Record<string, IGrokHookEntry[]>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isHookCommand = (value: unknown): value is IGrokHookCommand =>
  isRecord(value) && value.type === 'command' && typeof value.command === 'string';

const isHookEntry = (value: unknown): value is IGrokHookEntry =>
  isRecord(value)
  && Array.isArray(value.hooks)
  && value.hooks.every(isHookCommand)
  && (value.matcher === undefined || typeof value.matcher === 'string');

const ownsCommand = (entry: IGrokHookEntry, scriptPath: string): boolean =>
  entry.hooks.some((hook) => hook.command.includes(scriptPath));

const purplemuxEntry = (scriptPath: string, event: TGrokHookEvent): IGrokHookEntry => ({
  hooks: [{ type: 'command', command: `sh "${scriptPath}" ${event}`, timeout: HOOK_TIMEOUT_SEC }],
});

export interface IMergeGrokHookSettingsResult {
  settings: Record<string, unknown>;
  changed: boolean;
}

/**
 * Folds purplemux's hook block into grok's user settings.
 *
 * Everything the user owns — `apiKey`, `defaultModel`, `subAgents`, `mcp`,
 * `telegram`, and any hook entry purplemux did not write — survives untouched.
 * Re-running replaces only purplemux's own entries, so the merge is idempotent.
 */
export const mergeGrokHookSettings = (
  existing: unknown,
  scriptPath: string,
): IMergeGrokHookSettingsResult => {
  const base: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  const existingHooks = isRecord(base.hooks) ? base.hooks : {};
  const nextHooks: TGrokHookConfig = {};

  for (const [event, value] of Object.entries(existingHooks)) {
    const entries = Array.isArray(value) ? value.filter(isHookEntry) : [];
    const foreign = entries.filter((entry) => !ownsCommand(entry, scriptPath));
    if (foreign.length > 0 || entries.length === 0) nextHooks[event] = foreign;
  }

  for (const event of GROK_HOOK_EVENTS) {
    nextHooks[event] = [...(nextHooks[event] ?? []), purplemuxEntry(scriptPath, event)];
  }

  base.hooks = nextHooks;
  const changed = JSON.stringify(isRecord(existing) ? existing : {}) !== JSON.stringify(base);
  return { settings: base, changed };
};

type TReadResult =
  | { state: 'missing' }
  | { state: 'parsed'; value: unknown }
  | { state: 'corrupt' };

const readSettings = async (settingsPath: string): Promise<TReadResult> => {
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, 'utf-8');
  } catch {
    return { state: 'missing' };
  }
  try {
    return { state: 'parsed', value: JSON.parse(raw) };
  } catch {
    return { state: 'corrupt' };
  }
};

export class GrokSettingsUnreadableError extends Error {
  constructor(readonly settingsPath: string) {
    super(`${settingsPath} is not valid JSON; refusing to overwrite it`);
    this.name = 'GrokSettingsUnreadableError';
  }
}

/**
 * Writes grok's settings through a sibling temp file so a crash mid-write can
 * never leave the user without an `apiKey`. A settings file that exists but
 * does not parse is left alone and reported: overwriting it would destroy the
 * user's API key to install a hook.
 */
export const ensureGrokHookSettings = async (
  scriptPath: string,
  settingsPath: string = GROK_USER_SETTINGS_PATH,
): Promise<boolean> => {
  const dir = path.dirname(settingsPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const read = await readSettings(settingsPath);
  if (read.state === 'corrupt') throw new GrokSettingsUnreadableError(settingsPath);
  const existing = read.state === 'parsed' ? read.value : null;
  const { settings, changed } = mergeGrokHookSettings(existing, scriptPath);
  if (!changed) return false;

  const tmpPath = path.join(dir, `.user-settings.${process.pid}.tmp`);
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmpPath, settingsPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    log.error({ err: err instanceof Error ? err.message : err, settingsPath }, 'grok user-settings merge failed');
    throw err;
  }
  return true;
};
