import { execFile as execFileCb } from 'child_process';
import fs from 'fs/promises';
import { promisify } from 'util';
import { getShellPath } from '@/lib/preflight';
import { createLogger } from '@/lib/logger';
import { parseSemanticVersion } from '@/lib/process-utils';
import { GROK_AUTH_PATH, GROK_BIN_DIR, GROK_BIN_PATH } from '@/lib/providers/grok/paths';
import type { IGrokStatus } from '@/types/preflight';

const execFile = promisify(execFileCb);
const CMD_TIMEOUT = 5000;
const TTL_MS = 60_000;

const log = createLogger('grok-preflight');

export { GROK_BIN_DIR, GROK_BIN_PATH };

const g = globalThis as unknown as {
  __ptGrokPreflight?: { result: IGrokStatus; checkedAt: number };
};

const withGrokBin = (shellPath: string): string =>
  shellPath.split(':').includes(GROK_BIN_DIR) ? shellPath : `${GROK_BIN_DIR}:${shellPath}`;

const exists = async (target: string): Promise<boolean> =>
  fs.access(target).then(() => true).catch(() => false);

/**
 * `grok --version` prints `grok 1.0.4 (d846eb93d9)`.
 *
 * The install script drops the binary at `~/.grok/bin/grok` and does not always
 * put that directory on PATH, so it is prepended before probing — and the
 * absolute path wins when resolving `binaryPath`, because the parked community
 * `grok-cli` builds a binary of the same name.
 */
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

  if (await exists(GROK_BIN_PATH)) return { installed: true, version, binaryPath: GROK_BIN_PATH };

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
 * Grok Build signs in through browser OAuth and stores the tokens in
 * `~/.grok/auth.json` (`02-authentication.md`); `XAI_API_KEY` is the fallback
 * when no session token exists. Only the presence of either is read.
 */
export const checkGrokLogin = async (authPath: string = GROK_AUTH_PATH): Promise<boolean> => {
  if (process.env.XAI_API_KEY) return true;
  return exists(authPath);
};
