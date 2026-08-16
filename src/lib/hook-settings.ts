import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createLogger } from '@/lib/logger';
import { STATUSLINE_SCRIPT_PATH, STATUSLINE_SCRIPT_CONTENT } from '@/lib/statusline-script';
import { ensureGrokHookFiles } from '@/lib/providers/grok/hook-config';
import { GROK_HOOK_SCRIPT_PATH as GROK_HOOK_SCRIPT } from '@/lib/providers/grok/paths';

const log = createLogger('hooks');
const codexLog = createLogger('codex-hook');
const grokLog = createLogger('grok-hook');

const BASE_DIR = path.join(os.homedir(), '.purplemux');
const HOOKS_FILE = path.join(BASE_DIR, 'hooks.json');
const PORT_FILE = path.join(BASE_DIR, 'port');
const HOOK_SCRIPT = path.join(BASE_DIR, 'status-hook.sh');
const CODEX_HOOK_SCRIPT = path.join(BASE_DIR, 'codex-hook.sh');

export const HOOK_SETTINGS_PATH = HOOKS_FILE;
export const CODEX_HOOK_SCRIPT_PATH = CODEX_HOOK_SCRIPT;
export const GROK_HOOK_SCRIPT_PATH = GROK_HOOK_SCRIPT;

const HOOK_SCRIPT_CONTENT = `#!/bin/sh
EVENT="\${1:-poll}"
PORT_FILE="$HOME/.purplemux/port"
TOKEN_FILE="$HOME/.purplemux/cli-token"
[ -f "$PORT_FILE" ] || exit 0
[ -f "$TOKEN_FILE" ] || exit 0
PORT=$(cat "$PORT_FILE")
TOKEN=$(cat "$TOKEN_FILE")
SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null) || SESSION=""

# Tool activity feeds the signal engine, not the work-state machine. Forward the
# raw hook JSON so the server parses it — sed cannot survive a command string
# containing quotes. Detached, because this fires on every mutating tool call
# and no edit should wait on the round trip.
if [ "$EVENT" = "post-tool" ]; then
  BODY=$(cat)
  [ -n "$BODY" ] || exit 0
  curl -s -X POST -o /dev/null --max-time 2 \\
    -H 'Content-Type: application/json' -H "x-pmux-token: \${TOKEN}" \\
    -d "$BODY" \\
    "http://localhost:\${PORT}/api/status/hook?kind=tool&session=\${SESSION}" >/dev/null 2>&1 &
  exit 0
fi

NOTIFICATION_TYPE=""
if [ "$EVENT" = "notification" ]; then
  NOTIFICATION_TYPE=$(sed -n 's/.*"notification_type"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
fi

PAYLOAD="{\\"event\\":\\"\${EVENT}\\",\\"session\\":\\"\${SESSION}\\""
if [ -n "$NOTIFICATION_TYPE" ]; then
  PAYLOAD="\${PAYLOAD},\\"notificationType\\":\\"\${NOTIFICATION_TYPE}\\""
fi
PAYLOAD="\${PAYLOAD}}"

curl -s -X POST -o /dev/null -H 'Content-Type: application/json' -H "x-pmux-token: \${TOKEN}" -d "$PAYLOAD" "http://localhost:\${PORT}/api/status/hook" 2>/dev/null
exit 0
`;

const CODEX_HOOK_SCRIPT_CONTENT = `#!/usr/bin/env bash
set -u
PORT_FILE="$HOME/.purplemux/port"
TOKEN_FILE="$HOME/.purplemux/cli-token"
[ -f "$PORT_FILE" ] || exit 0
[ -f "$TOKEN_FILE" ] || exit 0
PORT=$(cat "$PORT_FILE")
TOKEN=$(cat "$TOKEN_FILE")
SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null) || SESSION=""

curl -sS -X POST -o /dev/null \\
  -H "x-pmux-token: \${TOKEN}" \\
  -H "Content-Type: application/json" \\
  --data-binary @- \\
  "http://localhost:\${PORT}/api/status/hook?provider=codex&tmuxSession=\${SESSION}" 2>/dev/null || true
exit 0
`;

/**
 * Grok Build pipes the hook payload as JSON on stdin. The body is forwarded
 * verbatim and the route reads its camelCase fields — `hookEventName` included,
 * so the event needs no query parameter of its own.
 *
 * The POST is detached and time-boxed: a `Stop` hook runs on the turn's
 * critical path, `PostToolUse` fires on every mutating tool call, and neither
 * may wait on the round trip. Always exits 0, because a non-zero exit from a
 * `Stop` hook would block grok from finishing its turn.
 */
export const GROK_HOOK_SCRIPT_CONTENT = `#!/bin/sh
PORT_FILE="$HOME/.purplemux/port"
TOKEN_FILE="$HOME/.purplemux/cli-token"
[ -f "$PORT_FILE" ] || exit 0
[ -f "$TOKEN_FILE" ] || exit 0
PORT=$(cat "$PORT_FILE")
TOKEN=$(cat "$TOKEN_FILE")
SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null) || SESSION=""
[ -n "$SESSION" ] || exit 0

BODY=$(cat)
[ -z "$BODY" ] && BODY='{}'

printf '%s' "$BODY" | curl -s -X POST -o /dev/null --max-time 2 \\
  -H 'Content-Type: application/json' -H "x-pmux-token: \${TOKEN}" \\
  --data-binary @- \\
  "http://localhost:\${PORT}/api/status/hook?provider=grok&tmuxSession=\${SESSION}" >/dev/null 2>&1 &
exit 0
`;

const hookEntry = (event: string, timeout = 3, matcher = '') => [
  {
    matcher,
    hooks: [
      {
        type: 'command',
        command: `sh "${HOOK_SCRIPT}" ${event}`,
        timeout,
      },
    ],
  },
];

// Only the tools that can produce a signal. Read/Grep/Glob dominate a session's
// tool calls and can never put an edit out of scope or fail repeatedly, so
// matching them would multiply hook invocations for nothing.
const SIGNAL_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit|Bash';

const buildHookSettings = () => ({
  hooks: {
    SessionStart: hookEntry('session-start'),
    UserPromptSubmit: hookEntry('prompt-submit'),
    Notification: hookEntry('notification'),
    Stop: hookEntry('stop'),
    StopFailure: hookEntry('stop'),
    PreCompact: hookEntry('pre-compact'),
    PostCompact: hookEntry('post-compact'),
    PostToolUse: hookEntry('post-tool', 2, SIGNAL_TOOLS),
  },
  statusLine: {
    type: 'command' as const,
    command: `sh "${STATUSLINE_SCRIPT_PATH}"`,
  },
});

const writeManagedScript = async (target: string, body: string, mode: number): Promise<void> => {
  try {
    const existing = await fs.readFile(target, 'utf-8');
    if (existing !== body) {
      await fs.writeFile(target, body, { mode });
    }
  } catch {
    await fs.writeFile(target, body, { mode });
  }
};

export interface IEnsureHookSettingsResult {
  codexHookInstallFailed: boolean;
  grokHookInstallFailed: boolean;
}

export const ensureHookSettings = async (port: number): Promise<IEnsureHookSettingsResult> => {
  await fs.mkdir(BASE_DIR, { recursive: true });

  await fs.writeFile(PORT_FILE, String(port), { mode: 0o600 });

  await writeManagedScript(HOOK_SCRIPT, HOOK_SCRIPT_CONTENT, 0o755);
  await writeManagedScript(STATUSLINE_SCRIPT_PATH, STATUSLINE_SCRIPT_CONTENT, 0o755);

  let codexHookInstallFailed = false;
  try {
    await writeManagedScript(CODEX_HOOK_SCRIPT, CODEX_HOOK_SCRIPT_CONTENT, 0o700);
  } catch (err) {
    codexHookInstallFailed = true;
    codexLog.error({ err }, 'codex-hook script write failed');
  }

  let grokHookInstallFailed = false;
  try {
    await writeManagedScript(GROK_HOOK_SCRIPT, GROK_HOOK_SCRIPT_CONTENT, 0o700);
    await ensureGrokHookFiles(GROK_HOOK_SCRIPT);
  } catch (err) {
    grokHookInstallFailed = true;
    grokLog.error({ err }, 'grok hook install failed');
  }

  const settings = buildHookSettings();
  const content = JSON.stringify(settings, null, 2) + '\n';

  try {
    const existing = await fs.readFile(HOOKS_FILE, 'utf-8');
    if (existing === content) return { codexHookInstallFailed, grokHookInstallFailed };
  } catch {
    // file doesn't exist yet
  }

  await fs.writeFile(HOOKS_FILE, content, { mode: 0o600 });
  log.debug(`${HOOKS_FILE} created`);
  return { codexHookInstallFailed, grokHookInstallFailed };
};

export const removePortFile = async (): Promise<void> => {
  try {
    await fs.unlink(PORT_FILE);
  } catch {
    // already removed
  }
};
