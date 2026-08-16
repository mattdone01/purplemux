import { execFile as execFileCb } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { getShellPath } from '@/lib/preflight';
import { createLogger } from '@/lib/logger';
import { parseSemanticVersion } from '@/lib/process-utils';
import { GROK_HOME } from '@/lib/providers/grok/db';
import { GROK_USER_SETTINGS_PATH } from '@/lib/providers/grok/hook-config';
import type { IGrokStatus } from '@/types/preflight';

const execFile = promisify(execFileCb);
const CMD_TIMEOUT = 5000;
const TTL_MS = 60_000;

const log = createLogger('grok-preflight');

/** The install script drops the binary here and does not always touch PATH. */
export const GROK_BIN_DIR = path.join(GROK_HOME, 'bin');
export const GROK_BIN_PATH = path.join(GROK_BIN_DIR, 'grok');

const g = globalThis as unknown as {
  __ptGrokPreflight?: { result: IGrokStatus; checkedAt: number };
};

const withGrokBin = (shellPath: string): string =>
  shellPath.split(':').includes(GROK_BIN_DIR) ? shellPath : `${GROK_BIN_DIR}:${shellPath}`;

const probe = async (): Promise<IGrokStatus> => {
  const env = { ...process.env, PATH: withGrokBin(await getShellPath()) };

  let version: string | null = null;
  try {
    const { stdout } = await execFile('grok', ['--version'], { timeout: CMD_TIMEOUT, env });
    version = parseSemanticVersion(stdout);
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : err }, 'grok --version failed');
    return { installed: false, version: null, binaryPath: null };
  }

  let binaryPath: string | null = null;
  try {
    const { stdout } = await execFile('which', ['grok'], { timeout: CMD_TIMEOUT, env });
    binaryPath = stdout.trim() || null;
  } catch {
    binaryPath = null;
  }

  return { installed: true, version, binaryPath };
};

export const runGrokPreflight = async (force = false): Promise<IGrokStatus> => {
  if (!force && g.__ptGrokPreflight && Date.now() - g.__ptGrokPreflight.checkedAt < TTL_MS) {
    return g.__ptGrokPreflight.result;
  }
  const result = await probe();
  g.__ptGrokPreflight = { result, checkedAt: Date.now() };
  return result;
};

export const invalidateGrokPreflight = (): void => {
  g.__ptGrokPreflight = undefined;
};

/**
 * grok resolves its key from `GROK_API_KEY` or `apiKey` in user settings
 * (`src/utils/settings.ts`). Only the presence of a key is read — never its value.
 */
export const checkGrokApiKey = async (
  settingsPath: string = GROK_USER_SETTINGS_PATH,
): Promise<boolean> => {
  if (process.env.GROK_API_KEY) return true;
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8')) as { apiKey?: unknown };
    return typeof parsed.apiKey === 'string' && parsed.apiKey.length > 0;
  } catch {
    return false;
  }
};
