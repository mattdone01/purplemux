import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { listGrokHomes } from '@/lib/grok-home';
import { grokHooksDir } from '@/lib/providers/grok/paths';

const log = createLogger('grok-hooks');

/**
 * purplemux owns exactly this file inside `$GROK_HOME/hooks/`. Grok merges every
 * `*.json` in that directory (`10-hooks.md`, "Hook Locations"), so writing one
 * named file leaves the user's own hooks untouched.
 */
export const GROK_HOOK_FILE_NAME = 'purplemux.json';

const OBSERVE_TIMEOUT_SEC = 3;

/**
 * `Notification` types that matter to a host UI: a permission prompt is waiting,
 * the session settled, or a task finished (`10-hooks.md`, "Hook Events").
 */
export const GROK_NOTIFICATION_MATCHER = 'permission_prompt|idle_prompt|task_complete';

/**
 * Tools whose completion is a signal. grok's own names are
 * `search_replace` / `run_terminal_command`; a matcher also keeps the Claude
 * names it aliases them from, so both spellings are listed and either fires.
 */
export const GROK_TOOL_MATCHER = 'Edit|Write|MultiEdit|Bash|search_replace|run_terminal_command';

export interface IGrokHookCommand {
  type: 'command';
  command: string;
  timeout: number;
}

export interface IGrokHookGroup {
  matcher?: string;
  hooks: IGrokHookCommand[];
}

export type TGrokHookConfig = { hooks: Record<string, IGrokHookGroup[]> };

const command = (scriptPath: string): IGrokHookCommand => ({
  type: 'command',
  command: `sh "${scriptPath}"`,
  timeout: OBSERVE_TIMEOUT_SEC,
});

/**
 * The five registrations `10-hooks.md` calls "a complete busy and idle
 * indicator", plus compaction, teardown and tool activity.
 *
 * `Stop` is a gate that re-fires on every continuation round, so a host that
 * settled on it alone would show a false idle; `idle_prompt` is the documented
 * backstop and the handler gates the settle on the tab still being busy.
 */
export const buildGrokHookConfig = (scriptPath: string): TGrokHookConfig => {
  const observe = [{ hooks: [command(scriptPath)] }];
  return {
    hooks: {
      SessionStart: observe,
      UserPromptSubmit: observe,
      Stop: observe,
      StopFailure: observe,
      StopCancelled: observe,
      Notification: [{ matcher: GROK_NOTIFICATION_MATCHER, hooks: [command(scriptPath)] }],
      PreCompact: observe,
      PostCompact: observe,
      SessionEnd: observe,
      PostToolUse: [{ matcher: GROK_TOOL_MATCHER, hooks: [command(scriptPath)] }],
    },
  };
};

/**
 * Writes purplemux's hook file into one grok home. Rewritten on every boot so a
 * changed script path or event set lands, and skipped when the content already
 * matches so an unchanged boot does not touch the file's mtime.
 */
export const writeGrokHookFile = async (home: string, scriptPath: string): Promise<boolean> => {
  const dir = grokHooksDir(home);
  const target = path.join(dir, GROK_HOOK_FILE_NAME);
  const content = `${JSON.stringify(buildGrokHookConfig(scriptPath), null, 2)}\n`;

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const existing = await fs.readFile(target, 'utf-8').catch(() => null);
  if (existing === content) return false;

  const tmp = path.join(dir, `.${GROK_HOOK_FILE_NAME}.${process.pid}.tmp`);
  try {
    await fs.writeFile(tmp, content, { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return true;
};

/**
 * The unscoped `~/.grok` (ad-hoc tabs) and every workspace grok home. A home
 * created later is covered on the next boot; `ensureWorkspaceGrokHome` does not
 * install hooks itself, so the launch path stays free of file writes it does
 * not own.
 */
export const ensureGrokHookFiles = async (scriptPath: string): Promise<string[]> => {
  const written: string[] = [];
  for (const home of await listGrokHomes()) {
    try {
      if (await writeGrokHookFile(home, scriptPath)) written.push(home);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err, home }, 'grok hook file write failed');
      throw err;
    }
  }
  return written;
};
