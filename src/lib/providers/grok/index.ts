import { getDangerouslySkipPermissions } from '@/lib/config-store';
import { GROK_BIN_PATH, grokSessionIdFromJsonlPath } from '@/lib/providers/grok/paths';
import { checkGrokLogin, runGrokPreflight } from '@/lib/providers/grok/preflight';
import { readGrokRuntimeSnapshot, readGrokSessionHistoryStats } from '@/lib/providers/grok/runtime-snapshot';
import {
  detectActiveSession as detectGrokSession,
  isGrokRunning,
  watchSessions as watchGrokSessions,
} from '@/lib/providers/grok/session-detection';
import { isValidGrokSessionId } from '@/lib/providers/grok/session-store';
import { GROK_PROVIDER_ID } from '@/lib/session-parser-grok';
import type { IAgentPreflight, IAgentProvider } from '@/lib/providers/types';
import type { IAgentState, ITab } from '@/types/terminal';

export { GROK_PROVIDER_ID };

type TAgentField = 'sessionId' | 'jsonlPath' | 'summary';

const ensureAgentState = (tab: ITab): IAgentState => {
  if (tab.agentState?.providerId === GROK_PROVIDER_ID) return tab.agentState;
  const seeded: IAgentState = {
    providerId: GROK_PROVIDER_ID,
    sessionId: null,
    jsonlPath: null,
    summary: null,
  };
  tab.agentState = seeded;
  return seeded;
};

const readField = (tab: ITab, field: TAgentField): string | null => {
  if (tab.agentState?.providerId !== GROK_PROVIDER_ID) return null;
  return tab.agentState[field] ?? null;
};

const writeField = (tab: ITab, field: TAgentField, value: string | null | undefined) => {
  ensureAgentState(tab)[field] = value ?? null;
};

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The install script drops grok at `~/.grok/bin/grok` without always putting
 * that directory on PATH, and the parked community `grok-cli` builds a binary of
 * the same name — so the absolute path is preferred and PATH is only the
 * fallback for an install that lives somewhere else.
 */
const grokBinary = async (): Promise<string> => {
  const { binaryPath } = await runGrokPreflight();
  return binaryPath ? shellSingleQuote(binaryPath) : shellSingleQuote(GROK_BIN_PATH);
};

/**
 * The pane's `GROK_HOME` is exported by the login shell (`src/lib/tmux.ts`), so
 * the command itself only has to name the working directory, the permission
 * mode and — on a resume — the session.
 */
export const composeGrokLaunchCommand = async (resumeSessionId?: string): Promise<string> => {
  const parts = [await grokBinary(), '--cwd', '"$PWD"'];
  if (await getDangerouslySkipPermissions()) parts.push('--permission-mode', 'bypassPermissions');
  if (resumeSessionId) parts.push('--resume', shellSingleQuote(resumeSessionId));
  return parts.join(' ');
};

const grokAgentPreflight = async (): Promise<IAgentPreflight> => {
  const status = await runGrokPreflight();
  return {
    installed: status.installed,
    version: status.version,
    binaryPath: status.binaryPath,
    loggedIn: status.installed ? await checkGrokLogin() : false,
  };
};

export const grokProvider: IAgentProvider = {
  id: GROK_PROVIDER_ID,
  displayName: 'Grok',
  panelType: 'grok-cli',

  matchesProcess: (commandName, args) => {
    if (commandName === 'grok' || commandName === 'agent') return true;
    return Boolean(args?.some((arg) => arg === GROK_BIN_PATH || arg.endsWith('/.grok/bin/grok')));
  },
  isValidSessionId: isValidGrokSessionId,

  detectActiveSession: (panePid, childPids, options) => detectGrokSession(panePid, childPids, options),
  isAgentRunning: (panePid, childPids) => isGrokRunning(panePid, childPids),
  watchSessions: (panePid, onChange, options) => watchGrokSessions(panePid, onChange, options),

  buildLaunchCommand: () => composeGrokLaunchCommand(),
  buildResumeCommand: (sessionId) => {
    if (!isValidGrokSessionId(sessionId)) {
      throw new Error(`Invalid grok session ID format: ${sessionId}`);
    }
    return composeGrokLaunchCommand(sessionId);
  },

  readSessionId: (tab) => readField(tab, 'sessionId'),
  writeSessionId: (tab, sessionId) => writeField(tab, 'sessionId', sessionId),
  readJsonlPath: (tab) => readField(tab, 'jsonlPath'),
  writeJsonlPath: (tab, jsonlPath) => writeField(tab, 'jsonlPath', jsonlPath),
  readSummary: (tab) => readField(tab, 'summary'),
  writeSummary: (tab, summary) => writeField(tab, 'summary', summary),

  /** grok's TUI does not write a pane title. */
  parsePaneTitle: () => null,
  sessionIdFromJsonlPath: grokSessionIdFromJsonlPath,
  readRuntimeSnapshot: (jsonlPath) => readGrokRuntimeSnapshot(jsonlPath),
  readSessionHistoryStats: (jsonlPath) => readGrokSessionHistoryStats(jsonlPath),
  preflight: grokAgentPreflight,
};
