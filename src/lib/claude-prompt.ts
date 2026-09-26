import fs from 'fs/promises';
import path from 'path';
import { resolveLayoutDir } from '@/lib/layout-store';
import type { IWorkspace } from '@/types/terminal';

export const getClaudePromptPath = (workspaceId: string): string =>
  path.join(resolveLayoutDir(workspaceId), 'claude-prompt.md');

const buildBody = (ws: IWorkspace): string => {
  return `# purplemux context

You are running inside a purplemux workspace tab.

- **Workspace ID**: \`${ws.id}\`

Use \`purplemux workspaces\` if you need the workspace name or directories.

## purplemux CLI

The \`purplemux\` CLI lets you inspect and control other tabs in this workspace.
It reads port and token from \`~/.purplemux/{port,cli-token}\` automatically,
so no environment setup is needed.

### Commands

\`\`\`bash
purplemux workspaces                                # list all workspaces
purplemux tab list -w ${ws.id}                        # list tabs in this workspace
purplemux tab create -w ${ws.id} [-n NAME] [-t TYPE]  # create a tab (type: terminal | claude-code | codex-cli | agent-sessions | web-browser | diff)
                    [--reports-to TAB_ID]              # its watchdog nudges go to TAB_ID, not the workspace orchestrator
purplemux tab send -w ${ws.id} TAB_ID CONTENT...      # send input to a tab
purplemux tab status -w ${ws.id} TAB_ID               # tab status
purplemux tab result -w ${ws.id} TAB_ID               # capture current pane content
purplemux tab close -w ${ws.id} TAB_ID                # close a tab
purplemux tab bg add -w ${ws.id} TAB_ID --pid N --notify self  # wake TAB_ID itself when pid N exits
purplemux standup report -w ${ws.id} --json '{...}'   # post a standup tick — the human-readable progress digest
purplemux standup show -w ${ws.id}                    # latest standup + history
purplemux lease check NAME                            # exact name; exit 0 you hold it, 3 another does, 7 nobody
purplemux lease acquire NAME [--ttl 45m] [--epic S]   # e.g. merge:owner/repo, epic:SLUG; exit 3 + stderr lease-held = held elsewhere
purplemux lease release NAME                          # release what you hold; lease list shows every holder
purplemux inbox list -w ${ws.id}                        # server notices queued or held for this workspace's tabs
\`\`\`

The watchdog reads the LAST line of your turn: \`DONE:\`, \`BLOCKED:\`, \`NEEDS-DECISION:\` or
\`READY-TO-MERGE:\` reaches your orchestrator verbatim. A turn that ends with no such line while
your background shells, agents or registered jobs still run is WAITING: no nudge until they finish.

Exit codes: 4 means the target tab is gone (\`tab-not-found\`, \`session-not-running\`,
\`target-changed\`) — never retry it. 5 (agent not ready) and 6 (server unreachable) may be
retried a bounded number of times. \`purplemux help\` lists all eight.

For the full HTTP API reference (including endpoint paths and payloads),
run:

\`\`\`bash
purplemux api-guide
\`\`\`

### When to use

- Delegate work to another tab when a task benefits from isolation
  (long-running builds, different project context, parallel exploration).
- Poll \`status\` and read \`result\` to verify delegated work.
- Prefer small, scoped tabs over cramming everything into one session.

### Tab type notes

- **\`web-browser\` tabs**: Electron webviews, not tmux. The \`alive\` field in
  \`tab list\` / \`tab status\` is always \`false\` for these — that is the normal
  value, not a sign the tab is dead. Do not gate actions on \`alive\`. Use the
  browser-specific HTTP endpoints (\`/browser/url\`, \`/browser/screenshot\`, …;
  see \`purplemux api-guide\`) directly.
- **\`terminal\` / \`claude-code\` / \`codex-cli\` tabs**: run inside tmux, so \`alive\` is a valid
  liveness signal.
`;
};

export const writeClaudePromptFile = async (ws: IWorkspace): Promise<void> => {
  const filePath = getClaudePromptPath(ws.id);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = buildBody(ws);
  try {
    const existing = await fs.readFile(filePath, 'utf-8');
    if (existing === body) return;
  } catch {
    // missing — write below
  }
  await fs.writeFile(filePath, body, 'utf-8');
};
