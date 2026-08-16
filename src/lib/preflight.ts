import { execFile as execFileCb } from 'child_process';
import os from 'os';
import { promisify } from 'util';
import type { IRuntimePreflightResult } from '@/types/preflight';
import { buildShellEnv, defaultShell as resolveDefaultShell } from '@/lib/shell-env';
import { PRISTINE_ENV } from '@/lib/pristine-env';
import { claudeProvider } from '@/lib/providers/claude';
import { runCodexPreflight, invalidateCodexPreflight } from '@/lib/providers/codex/preflight';
import { checkGrokLogin, invalidateGrokPreflight, runGrokPreflight } from '@/lib/providers/grok/preflight';
import { parseSemanticVersion } from '@/lib/process-utils';

const execFile = promisify(execFileCb);
const CMD_TIMEOUT = 5000;

let shellPathCache: string | null = null;
let shellPathPromise: Promise<string> | null = null;

const defaultShell = () => os.userInfo().shell || resolveDefaultShell();

const resolveShellPathAsync = async (): Promise<string> => {
  const shell = defaultShell();
  try {
    const { stdout } = await execFile(shell, ['-ilc', 'echo -n "$PATH"'], {
      timeout: CMD_TIMEOUT,
      env: {
        ...buildShellEnv(),
        SHELL: shell,
        DISABLE_AUTO_UPDATE: 'true',
        ZSH_TMUX_AUTOSTARTED: 'true',
      },
    });
    return stdout.toString().trim();
  } catch {
    return PRISTINE_ENV.PATH || '';
  }
};

export const initShellPath = async (): Promise<void> => {
  shellPathCache = await resolveShellPathAsync();
};

export const getShellPath = async (): Promise<string> => {
  if (shellPathCache) return shellPathCache;
  if (!shellPathPromise) {
    shellPathPromise = resolveShellPathAsync().then((result) => {
      shellPathCache = result;
      shellPathPromise = null;
      return result;
    });
  }
  return shellPathPromise;
};
const MIN_TMUX_VERSION = 2.9;

interface IToolStatus {
  installed: boolean;
  version: string | null;
}

interface IPreflightResult {
  tmux: IToolStatus & { compatible: boolean };
  git: IToolStatus;
  brew?: IToolStatus;
  clt?: { installed: boolean };
}

const checkTool = async (
  cmd: string,
  args: string[],
  parseVersion: (stdout: string) => string | null,
): Promise<IToolStatus> => {
  try {
    const resolvedPath = await getShellPath();
    const { stdout } = await execFile(cmd, args, { timeout: CMD_TIMEOUT, env: { ...process.env, PATH: resolvedPath } });
    return { installed: true, version: parseVersion(stdout) };
  } catch {
    return { installed: false, version: null };
  }
};

const isTmuxCompatible = (tool: IToolStatus): boolean =>
  tool.installed && tool.version !== null && parseFloat(tool.version) >= MIN_TMUX_VERSION;

const checkClt = async (): Promise<{ installed: boolean }> => {
  try {
    await execFile('xcode-select', ['-p'], { timeout: CMD_TIMEOUT });
    return { installed: true };
  } catch {
    return { installed: false };
  }
};

export const getPreflightStatus = async (): Promise<IPreflightResult> => {
  shellPathCache = await resolveShellPathAsync();
  const [tmux, git] = await Promise.all([
    checkTool('tmux', ['-V'], parseSemanticVersion),
    checkTool('git', ['--version'], parseSemanticVersion),
  ]);

  const coreReady = isTmuxCompatible(tmux) && git.installed;

  const result: IPreflightResult = {
    tmux: { ...tmux, compatible: isTmuxCompatible(tmux) },
    git,
  };

  if (!coreReady) {
    if (process.platform === 'darwin') {
      const [brew, clt] = await Promise.all([
        checkTool('brew', ['--version'], parseSemanticVersion),
        checkClt(),
      ]);
      result.brew = brew;
      result.clt = clt;
    }
  }

  return result;
};

const RUNTIME_CACHE_TTL = 30_000;
let runtimeCache: { result: IRuntimePreflightResult; checkedAt: number } | null = null;
let inflightRequest: Promise<IRuntimePreflightResult> | null = null;

const PREFLIGHT_CACHE_TTL = 1_000;
let preflightCache: { result: IPreflightResult; checkedAt: number } | null = null;
let preflightInflight: Promise<IPreflightResult> | null = null;

export const getCachedPreflightStatus = async (): Promise<IPreflightResult> => {
  if (preflightCache && Date.now() - preflightCache.checkedAt < PREFLIGHT_CACHE_TTL) {
    return preflightCache.result;
  }
  if (preflightInflight) return preflightInflight;

  preflightInflight = getPreflightStatus()
    .then((result) => {
      preflightCache = { result, checkedAt: Date.now() };
      preflightInflight = null;
      return result;
    })
    .catch((err) => {
      preflightInflight = null;
      throw err;
    });

  return preflightInflight;
};

export const getRuntimePreflightStatus = async (): Promise<IRuntimePreflightResult> => {
  shellPathCache = await resolveShellPathAsync();
  const [tmux, git, claudeFull, codex, grok, grokLoggedIn] = await Promise.all([
    checkTool('tmux', ['-V'], parseSemanticVersion),
    checkTool('git', ['--version'], parseSemanticVersion),
    claudeProvider.preflight(),
    runCodexPreflight(),
    runGrokPreflight(),
    checkGrokLogin(),
  ]);

  return {
    tmux: { ...tmux, compatible: isTmuxCompatible(tmux) },
    git,
    claude: {
      installed: claudeFull.installed,
      version: claudeFull.version,
      binaryPath: claudeFull.binaryPath,
      loggedIn: claudeFull.loggedIn,
    },
    codex: {
      installed: codex.installed,
      version: codex.version,
      binaryPath: codex.binaryPath,
    },
    grok: {
      installed: grok.installed,
      version: grok.version,
      binaryPath: grok.binaryPath,
      loggedIn: grokLoggedIn,
    },
  };
};

export const getCachedRuntimePreflight = async (): Promise<IRuntimePreflightResult> => {
  if (runtimeCache && Date.now() - runtimeCache.checkedAt < RUNTIME_CACHE_TTL) {
    return runtimeCache.result;
  }
  if (inflightRequest) return inflightRequest;

  inflightRequest = getRuntimePreflightStatus()
    .then((result) => {
      runtimeCache = { result, checkedAt: Date.now() };
      inflightRequest = null;
      return result;
    })
    .catch((err) => {
      inflightRequest = null;
      throw err;
    });

  return inflightRequest;
};

export const invalidateRuntimeCache = (): void => {
  runtimeCache = null;
  inflightRequest = null;
  invalidateCodexPreflight();
  invalidateGrokPreflight();
};
