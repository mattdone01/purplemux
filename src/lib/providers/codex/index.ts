import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { isValidCodexEffort } from '@/lib/agent-effort';
import { isValidModelName } from '@/lib/claude-command-shared';
import { getDangerouslySkipPermissions } from '@/lib/config-store';
import { createLogger } from '@/lib/logger';
import { buildCodexHookFlags } from '@/lib/providers/codex/hook-config';
import { runCodexPreflight } from '@/lib/providers/codex/preflight';
import { getCodexPromptPath, toTomlBasicString, writeCodexPromptFile } from '@/lib/providers/codex/prompt';
import { readCodexRuntimeSnapshot } from '@/lib/providers/codex/runtime-snapshot';
import { readCodexSessionHistoryStats } from '@/lib/providers/codex/session-history-stats';
import {
  detectActiveSession as detectCodexSession,
  isCodexRunning,
  watchSessionsDir,
} from '@/lib/providers/codex/session-detection';
import type { IAgentLaunchCommandOptions, IAgentPreflight, IAgentProvider } from '@/lib/providers/types';
import type { IAgentState, ITab } from '@/types/terminal';

const log = createLogger('codex-provider');

export const CODEX_PROVIDER_ID = 'codex';
const PURPLEMUX_DIR = path.join(os.homedir(), '.purplemux');
export const CODEX_LAUNCHER_SCRIPT = path.join(PURPLEMUX_DIR, 'codex-launcher.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isValidCodexSessionId = (id: unknown): id is string =>
  typeof id === 'string' && UUID_RE.test(id);

type TAgentField = 'sessionId' | 'jsonlPath' | 'summary';

const ensureAgentState = (tab: ITab): IAgentState => {
  if (tab.agentState?.providerId === CODEX_PROVIDER_ID) return tab.agentState;
  const seeded: IAgentState = {
    providerId: CODEX_PROVIDER_ID,
    sessionId: null,
    jsonlPath: null,
    summary: null,
  };
  tab.agentState = seeded;
  return seeded;
};

const readField = (tab: ITab, field: TAgentField): string | null => {
  if (tab.agentState?.providerId !== CODEX_PROVIDER_ID) return null;
  return tab.agentState[field] ?? null;
};

const writeField = (tab: ITab, field: TAgentField, value: string | null | undefined) => {
  ensureAgentState(tab)[field] = value ?? null;
};

const sessionIdFromJsonlPath = (jsonlPath: string | null | undefined): string | null => {
  if (!jsonlPath) return null;
  const filename = path.basename(jsonlPath, '.jsonl');
  const match = filename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : null;
};

const parsePaneTitle = (_paneTitle: string | null): string | null => null;

const checkCodexLogin = async (): Promise<boolean> => {
  try {
    await fs.access(path.join(os.homedir(), '.codex', 'auth.json'));
    return true;
  } catch {
    return false;
  }
};

const codexAgentPreflight = async (): Promise<IAgentPreflight> => {
  const status = await runCodexPreflight();
  const loggedIn = status.installed ? await checkCodexLogin() : false;
  return {
    installed: status.installed,
    version: status.version,
    binaryPath: status.binaryPath,
    loggedIn,
  };
};

const buildDeveloperInstructionsArgs = async (workspaceId: string): Promise<string[]> => {
  const promptPath = getCodexPromptPath(workspaceId);
  let content: string;
  try {
    content = await fs.readFile(promptPath, 'utf-8');
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : err, promptPath }, 'codex-prompt read failed');
    return [];
  }
  const arg = `developer_instructions=${toTomlBasicString(content)}`;
  return ['-c', arg];
};

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const assertValidCodexLaunchOptions = (
  options: Pick<IAgentLaunchCommandOptions, 'model' | 'effort'>,
): void => {
  if (options.model !== undefined && !isValidModelName(options.model)) {
    throw new Error('Invalid Codex model');
  }
  if (options.effort !== undefined && !isValidCodexEffort(options.effort)) {
    throw new Error('Invalid Codex reasoning effort');
  }
};

export const CODEX_LAUNCHER_SCRIPT_CONTENT = `#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const baseDir = path.join(os.homedir(), '.purplemux');

const readTrim = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
};

const parseArgs = (argv) => {
  const result = { workspaceId: null, resumeSessionId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const next = argv[i + 1];
    if (item === '--workspace-id' && next) {
      result.workspaceId = next;
      i += 1;
    } else if (item.startsWith('--workspace-id=')) {
      result.workspaceId = item.slice('--workspace-id='.length);
    } else if (item === '--tab-id' && next) {
      result.tabId = next;
      i += 1;
    } else if (item.startsWith('--tab-id=')) {
      result.tabId = item.slice('--tab-id='.length);
    } else if (item === '--session-name' && next) {
      result.sessionName = next;
      i += 1;
    } else if (item.startsWith('--session-name=')) {
      result.sessionName = item.slice('--session-name='.length);
    } else if (item === '--generation' && next) {
      result.generation = next;
      i += 1;
    } else if (item.startsWith('--generation=')) {
      result.generation = item.slice('--generation='.length);
    } else if (item === '--resume-session-id' && next) {
      result.resumeSessionId = next;
      i += 1;
    } else if (item.startsWith('--resume-session-id=')) {
      result.resumeSessionId = item.slice('--resume-session-id='.length);
    } else if (item === '--model') {
      if (!next || next.startsWith('-')) throw new Error('--model requires a value');
      result.model = next;
      i += 1;
    } else if (item.startsWith('--model=')) {
      result.model = item.slice('--model='.length);
    } else if (item === '--effort') {
      if (!next || next.startsWith('-')) throw new Error('--effort requires a value');
      result.effort = next;
      i += 1;
    } else if (item.startsWith('--effort=')) {
      result.effort = item.slice('--effort='.length);
    }
  }
  return result;
};

const fetchArgs = async (payload) => {
  if (typeof fetch !== 'function') {
    throw new Error('Node.js 20+ is required to launch Codex from purplemux');
  }
  const port = readTrim(path.join(baseDir, 'port'));
  if (!port) throw new Error('purplemux port file is missing');
  const token = process.env.PMUX_TOKEN || readTrim(path.join(baseDir, 'cli-token'));
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-pmux-token'] = token;
  const res = await fetch(\`http://127.0.0.1:\${port}/api/cli/codex/launch-args\`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const message = await res.text().catch(() => '');
    throw new Error(\`failed to get Codex launch args: HTTP \${res.status} \${message}\`.trim());
  }
  const data = await res.json();
  if (!Array.isArray(data.args) || data.args.some((arg) => typeof arg !== 'string')) {
    throw new Error('invalid Codex launch args response');
  }
  return data.args;
};

const confirmLaunch = async (payload) => {
  if (!payload.generation) return;
  const port = readTrim(path.join(baseDir, 'port'));
  if (!port) throw new Error('purplemux port file is missing');
  const token = process.env.PMUX_TOKEN || readTrim(path.join(baseDir, 'cli-token'));
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-pmux-token'] = token;
  const res = await fetch(\`http://127.0.0.1:\${port}/api/cli/codex/launch-confirm\`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const message = await res.text().catch(() => '');
    throw new Error(\`failed to confirm Codex launch: HTTP \${res.status} \${message}\`.trim());
  }
};

const main = async () => {
  const launch = parseArgs(process.argv.slice(2));
  if (launch.generation && (!launch.workspaceId || !launch.tabId || !launch.sessionName)) {
    throw new Error('managed Codex launch identity is incomplete');
  }
  const args = await fetchArgs(launch);
  const child = spawn('codex', args, {
    stdio: 'inherit',
    env: launch.generation
      ? { ...process.env, PURPLEMUX_CODEX_GENERATION: launch.generation }
      : process.env,
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      setTimeout(() => process.exit(1), 100);
      return;
    }
    process.exit(code ?? 1);
  });
  child.on('error', (err) => {
    console.error(err.message || String(err));
    process.exit(1);
  });
  if (launch.generation && Number.isInteger(child.pid)) {
    try {
      await confirmLaunch({
        workspaceId: launch.workspaceId,
        tabId: launch.tabId,
        sessionName: launch.sessionName,
        generation: launch.generation,
        launcherPid: process.pid,
        childPid: child.pid,
      });
    } catch (err) {
      console.error(err && err.message ? err.message : String(err));
    }
  }
};

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
`;

const ensureCodexLauncherScript = async (): Promise<string> => {
  await fs.mkdir(PURPLEMUX_DIR, { recursive: true, mode: 0o700 });
  try {
    const existing = await fs.readFile(CODEX_LAUNCHER_SCRIPT, 'utf-8');
    if (existing === CODEX_LAUNCHER_SCRIPT_CONTENT) {
      await fs.chmod(CODEX_LAUNCHER_SCRIPT, 0o700).catch(() => {});
      return CODEX_LAUNCHER_SCRIPT;
    }
  } catch {
    // missing or unreadable; rewrite below
  }
  await fs.writeFile(CODEX_LAUNCHER_SCRIPT, CODEX_LAUNCHER_SCRIPT_CONTENT, { mode: 0o700 });
  return CODEX_LAUNCHER_SCRIPT;
};

export const buildCodexRuntimeArgs = async (
  workspaceId: string | undefined,
  resumeSessionId?: string,
  options: Pick<IAgentLaunchCommandOptions, 'model' | 'effort'> = {},
): Promise<string[]> => {
  if (resumeSessionId && !isValidCodexSessionId(resumeSessionId)) {
    throw new Error(`Invalid codex session ID format: ${resumeSessionId}`);
  }
  assertValidCodexLaunchOptions(options);
  const skipPerms = await getDangerouslySkipPermissions();
  const { args: hookArgs } = await buildCodexHookFlags();
  const devInstrArgs = workspaceId ? await buildDeveloperInstructionsArgs(workspaceId) : [];

  const parts: string[] = [];
  if (resumeSessionId) parts.push('resume', resumeSessionId);
  if (options.model) parts.push('--model', options.model);
  if (options.effort) {
    parts.push('-c', `model_reasoning_effort=${options.effort}`);
  }
  parts.push(...hookArgs);
  parts.push(...devInstrArgs);
  if (skipPerms) parts.push('--yolo');
  return parts;
};

const composeLaunchCommand = async (
  workspaceId: string | undefined,
  resumeSessionId?: string,
  options: Pick<IAgentLaunchCommandOptions, 'model' | 'effort'> = {},
): Promise<string> => {
  assertValidCodexLaunchOptions(options);
  const scriptPath = await ensureCodexLauncherScript();
  const parts = ['node', shellSingleQuote(scriptPath)];
  if (workspaceId) parts.push('--workspace-id', shellSingleQuote(workspaceId));
  if (resumeSessionId) parts.push('--resume-session-id', shellSingleQuote(resumeSessionId));
  if (options.model) parts.push('--model', shellSingleQuote(options.model));
  if (options.effort) parts.push('--effort', shellSingleQuote(options.effort));
  return parts.join(' ');
};

export const buildManagedCodexLaunchCommand = async (identity: {
  workspaceId: string;
  tabId: string;
  sessionName: string;
  generation: string;
}): Promise<string> => {
  const scriptPath = await ensureCodexLauncherScript();
  return [
    'node',
    shellSingleQuote(scriptPath),
    '--generation',
    shellSingleQuote(identity.generation),
    '--workspace-id',
    shellSingleQuote(identity.workspaceId),
    '--tab-id',
    shellSingleQuote(identity.tabId),
    '--session-name',
    shellSingleQuote(identity.sessionName),
  ].join(' ');
};

export const codexProvider: IAgentProvider = {
  id: CODEX_PROVIDER_ID,
  displayName: 'Codex',
  panelType: 'codex-cli',

  matchesProcess: (commandName, args) => {
    if (commandName === 'codex') return true;
    if (commandName === 'node' && args?.some((a) => a.endsWith('codex.js'))) return true;
    return false;
  },
  isValidSessionId: isValidCodexSessionId,

  detectActiveSession: (panePid, childPids, options) => detectCodexSession(panePid, childPids, options),
  isAgentRunning: (panePid, childPids) => isCodexRunning(panePid, childPids),
  watchSessions: (panePid, onChange, options) => watchSessionsDir(panePid, onChange, options),

  buildLaunchCommand: ({ workspaceId, model, effort }) =>
    composeLaunchCommand(workspaceId ?? undefined, undefined, { model, effort }),
  buildResumeCommand: (sessionId, { workspaceId, model, effort }) => {
    if (!isValidCodexSessionId(sessionId)) {
      throw new Error(`Invalid codex session ID format: ${sessionId}`);
    }
    return composeLaunchCommand(workspaceId ?? undefined, sessionId, { model, effort });
  },

  readSessionId: (tab) => readField(tab, 'sessionId'),
  writeSessionId: (tab, sessionId) => writeField(tab, 'sessionId', sessionId),
  readJsonlPath: (tab) => readField(tab, 'jsonlPath'),
  writeJsonlPath: (tab, jsonlPath) => writeField(tab, 'jsonlPath', jsonlPath),
  readSummary: (tab) => readField(tab, 'summary'),
  writeSummary: (tab, summary) => writeField(tab, 'summary', summary),

  parsePaneTitle,
  sessionIdFromJsonlPath,
  readRuntimeSnapshot: readCodexRuntimeSnapshot,
  readSessionHistoryStats: readCodexSessionHistoryStats,
  preflight: codexAgentPreflight,
  writeWorkspacePrompt: writeCodexPromptFile,
};
