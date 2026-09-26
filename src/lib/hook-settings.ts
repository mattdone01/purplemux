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

export const HOOK_SCRIPT_CONTENT = `#!/bin/sh
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

# SessionStart names why the session (re)started; after an auto-compaction it is
# "compact", which is not a turn end (L30). Only a plain word is forwarded.
SOURCE=""
if [ "$EVENT" = "session-start" ]; then
  SOURCE=$(sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\\([a-z]*\\)".*/\\1/p' | head -n 1)
fi

PAYLOAD="{\\"event\\":\\"\${EVENT}\\",\\"session\\":\\"\${SESSION}\\""
if [ -n "$NOTIFICATION_TYPE" ]; then
  PAYLOAD="\${PAYLOAD},\\"notificationType\\":\\"\${NOTIFICATION_TYPE}\\""
fi
if [ -n "$SOURCE" ]; then
  PAYLOAD="\${PAYLOAD},\\"source\\":\\"\${SOURCE}\\""
fi
PAYLOAD="\${PAYLOAD}}"

curl -s -X POST -o /dev/null -H 'Content-Type: application/json' -H "x-pmux-token: \${TOKEN}" -d "$PAYLOAD" "http://localhost:\${PORT}/api/status/hook" 2>/dev/null

# A tab created before tab tokens has no PMUX_TAB_ID (story 36). At a session
# start, Claude hands this hook a file whose exports reach every later Bash
# command; ask for the tab's hook-time identity with the pane's own workspace
# token and the exact pane's session, and write it there. Never verified.
if [ "$EVENT" = "session-start" ] && [ -z "\${PMUX_TAB_ID:-}" ] && [ -n "\${PMUX_TOKEN:-}" ] \\
  && [ -n "\${CLAUDE_ENV_FILE:-}" ] && [ -n "\${TMUX_PANE:-}" ]; then
  PANE_SESSION=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null) || PANE_SESSION=""
  if [ -n "$PANE_SESSION" ]; then
    IDENT=$(curl -s --max-time 2 -X POST -H 'Content-Type: application/json' -H "x-pmux-token: \${PMUX_TOKEN}" \\
      -d "{\\"session\\":\\"\${PANE_SESSION}\\"}" "http://localhost:\${PORT}/api/cli/tab-identity" 2>/dev/null)
    ID_TAB=$(printf '%s' "$IDENT" | sed -n 's/.*"tabId"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9_-]*\\)".*/\\1/p')
    ID_WS=$(printf '%s' "$IDENT" | sed -n 's/.*"workspaceId"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9_-]*\\)".*/\\1/p')
    ID_TOKEN=$(printf '%s' "$IDENT" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([0-9a-f]\\{64\\}\\)".*/\\1/p')
    if [ -n "$ID_TAB" ] && [ -n "$ID_WS" ] && [ -n "$ID_TOKEN" ]; then
      # Guarded: a session the server recreates carries its own launch identity, which wins
      # over a stale env file sourced again on resume.
      printf '[ -n "\${PMUX_TAB_ID:-}" ] || { export PMUX_TAB_ID=%s; export PMUX_WORKSPACE_ID=%s; export PMUX_TAB_TOKEN=%s; }\\n' "$ID_TAB" "$ID_WS" "$ID_TOKEN" >> "$CLAUDE_ENV_FILE"
    fi
  fi
fi
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
GENERATION="\${PURPLEMUX_CODEX_GENERATION:-}"

curl -sS -X POST -o /dev/null \\
  -H "x-pmux-token: \${TOKEN}" \\
  -H "Content-Type: application/json" \\
  --data-binary @- \\
  "http://localhost:\${PORT}/api/status/hook?provider=codex&tmuxSession=\${SESSION}&generation=\${GENERATION}" 2>/dev/null || true
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
