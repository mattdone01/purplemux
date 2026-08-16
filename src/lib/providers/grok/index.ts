import { runGrokPreflight, checkGrokApiKey, GROK_BIN_PATH } from '@/lib/providers/grok/preflight';
import { readGrokRuntimeSnapshot, readGrokSessionHistoryStats } from '@/lib/providers/grok/runtime-snapshot';
import {
  detectActiveSession as detectGrokSession,
  isGrokRunning,
  isValidGrokSessionId,
  watchSessions as watchGrokSessions,
} from '@/lib/providers/grok/session-detection';
import { GROK_PROVIDER_ID } from '@/lib/providers/grok/transcript';
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
 * that directory on PATH, so fall back to the absolute path rather than
 * launching a pane that immediately reports "command not found".
 */
const grokBinary = async (): Promise<string> => {
  const { binaryPath } = await runGrokPreflight();
  return binaryPath ? 'grok' : shellSingleQuote(GROK_BIN_PATH);
};

/** grok resolves its workspace from the working directory, so the pane's cwd is the scope. */
const composeLaunchCommand = async (resumeSessionId?: string): Promise<string> => {
  const parts = [await grokBinary(), '-d', '"$PWD"'];
  if (resumeSessionId) parts.push('--session', shellSingleQuote(resumeSessionId));
  return parts.join(' ');
};

const grokAgentPreflight = async (): Promise<IAgentPreflight> => {
  const status = await runGrokPreflight();
  return {
    installed: status.installed,
    version: status.version,
    binaryPath: status.binaryPath,
    loggedIn: status.installed ? await checkGrokApiKey() : false,
  };
};

export const grokProvider: IAgentProvider = {
  id: GROK_PROVIDER_ID,
  displayName: 'Grok',
  panelType: 'grok-cli',

  matchesProcess: (commandName, args) => {
    if (commandName === 'grok') return true;
    return Boolean(args?.some((arg) => arg === GROK_BIN_PATH || arg.endsWith('/.grok/bin/grok')));
  },
  isValidSessionId: isValidGrokSessionId,

  detectActiveSession: (panePid, childPids, options) => detectGrokSession(panePid, childPids, options),
  isAgentRunning: (panePid, childPids) => isGrokRunning(panePid, childPids),
  watchSessions: (panePid, onChange, options) => watchGrokSessions(panePid, onChange, options),

  buildLaunchCommand: () => composeLaunchCommand(),
  buildResumeCommand: (sessionId) => {
    if (!isValidGrokSessionId(sessionId)) {
      throw new Error(`Invalid grok session ID format: ${sessionId}`);
    }
    return composeLaunchCommand(sessionId);
  },

  readSessionId: (tab) => readField(tab, 'sessionId'),
  writeSessionId: (tab, sessionId) => writeField(tab, 'sessionId', sessionId),
  readJsonlPath: (tab) => readField(tab, 'jsonlPath'),
  writeJsonlPath: (tab, jsonlPath) => writeField(tab, 'jsonlPath', jsonlPath),
  readSummary: (tab) => readField(tab, 'summary'),
  writeSummary: (tab, summary) => writeField(tab, 'summary', summary),

  /** grok's TUI does not write a pane title, and its store has no path to parse. */
  parsePaneTitle: () => null,
  sessionIdFromJsonlPath: () => null,
  readRuntimeSnapshot: (handle) => readGrokRuntimeSnapshot(handle),
  readSessionHistoryStats: (handle) => readGrokSessionHistoryStats(handle),
  preflight: grokAgentPreflight,
};
