import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyCliToken } from '@/lib/cli-token';

const GUIDE = `# purplemux CLI HTTP API

All endpoints require header \`x-pmux-token: <PMUX_TOKEN>\`.

## Workspace scope

Every agent tab launches with a token scoped to ITS OWN workspace (\`PMUX_TOKEN\` in
the pane environment). Naming a different workspace returns 403 — you cannot list,
read, drive, or create tabs anywhere but your own workspace, and an unscoped
\`GET /api/cli/tabs\` returns only tabs you may already act on.

Cross-workspace access is deliberate and rare: the TARGET workspace must name your
workspace id in its \`allowedPeers\`. Grants are one-directional. Ask the human to
add one rather than working around a 403.

Each workspace also gets its own agent session store — \`CLAUDE_CONFIG_DIR\` for
Claude, \`GROK_HOME\` for Grok — so several workspaces can share one project root
without sharing conversation history or resume lists.

## Workspaces

GET /api/cli/workspaces
  Response: { "workspaces": [{ "id": "...", "name": "...", "directories": [...] }] }

GET /api/cli/workspaces/<workspaceId>/directories
  Response: { "workspaceId", "name", "directories": [...] }

PATCH /api/cli/workspaces/<workspaceId>/directories
  Body: { "directories": ["/abs/path", ...] }   non-empty; replaces the whole list
  Repoint a workspace at different directories. directories[0] is the PRIMARY: it is
  the cwd for new tabs and it keys the claude/codex chat store, so it must be unique
  across workspaces (409 if another workspace already claims it). Later entries are
  navigation shortcuts and may overlap freely. Paths must be absolute and must exist
  (400 otherwise) — they are resolved on the server, not against your cwd.
  Existing tabs keep the cwd their tmux session was created with; only tabs created
  after the change land in the new primary directory.
  Response: { "workspaceId", "name", "directories": [...] }

## Tabs

GET /api/cli/tabs?workspaceId=WS
  List tabs. Without workspaceId, lists tabs across all workspaces.
  Response: { "tabs": [{ "tabId", "workspaceId", "name", "sessionName", "panelType", "agentProviderId", "agentSessionId" }] }

POST /api/cli/tabs
  Body: { "workspaceId": "WS", "name"?: "...", "panelType"?: "terminal" | "claude-code" | "codex-cli" | "grok-cli" | "agent-sessions" | "web-browser" | "diff",
          "model"?: "...", "reasoning"?: "minimal" | "low" | "medium" | "high", "launch"?: boolean }
  Invalid panelType returns HTTP 400 with validPanelTypes.
  Creates a tab in the first pane of the workspace. Agent tabs (claude-code / codex-cli / grok-cli)
  auto-launch their CLI with purplemux hooks wired, so the tab reports cliState and can
  receive prompts via send immediately. "model" sets the agent model (claude --model /
  codex --model); "reasoning" sets codex model_reasoning_effort; "launch": false keeps
  the old bare-shell behavior.
  Response: { "tabId", "workspaceId", "paneId", "sessionName", "name", "panelType", "agentProviderId", "agentSessionId", "launched" }

GET /api/cli/tabs/<tabId>?workspaceId=WS
  Tab info.
  Response: { "tabId", "workspaceId", "paneId", "name", "sessionName", "panelType", "agentProviderId", "agentSessionId" }

DELETE /api/cli/tabs/<tabId>?workspaceId=WS
  Close the tab (kills tmux session and removes from layout).

POST /api/cli/tabs/<tabId>/send?workspaceId=WS
  Body: { "content": "...", "waitMs"?: 0..600000 }
  Send text (bracketed paste + Enter) to the tab.
  For an agent tab (claude-code / codex-cli / grok-cli) the send waits until the tab can
  accept a turn, up to waitMs (default 60000). A booting agent swallows the Enter after a
  paste, so sending into one reports success over an agent that never starts. waitMs: 0
  answers with the current state instead of waiting. Terminal and browser tabs are ungated.
  Response: { "status": "sent", "submitted": boolean, "cliState": string | null }
  409 { "error": "agent-not-ready", "tabId", "cliState", "detail": "readiness-timeout" | "session-not-running", "waitedMs"? }
    — nothing was pasted, so a later Enter cannot submit a half-forgotten prompt.

GET /api/cli/tabs/<tabId>/status?workspaceId=WS
  Response: { "tabId", "workspaceId", "alive", "command", "cliState", "agentProviderId", "agentSessionId", "claudeSessionId",
              "probes": [...], "backgroundJobs": [...] }
  probes/backgroundJobs are the tab's registered liveness watch (see "Liveness watch"),
  so an idle tab that is HOLDING dead background work is distinguishable from an idle
  tab that is done.

GET /api/cli/tabs/<tabId>/result?workspaceId=WS
  Capture the current pane content.
  Response: { "content": "..." }

## Liveness watch

Watchers for DELEGATED WORK, not tab state. A tab that is idle while its background
job is dead looks identical to an idle healthy tab; the built-in watchdog only sees
pane/turn state. Register a probe (progress freshness) and/or a background pid
(process death) at dispatch time for any long-running job. Events fire an
orchestrator nudge (STALLED / LIVENESS PROBE FAILING / BACKGROUND JOB DIED — sent to
the workspace's orchestrator tab, or to the registering tab itself when there is no
orchestrator) AND a push alert to the human. Registrations persist across server
restarts and are dropped when the tab closes.

POST /api/cli/tabs/<tabId>/probe?workspaceId=WS
  Body: { "command": "...", "stalenessThresholdS": 60..604800, "intervalS"?: 30..604800 (default 60), "label"?: "default" }
  Requires the workspace's OWN token (registration executes a command server-side).
  The watchdog runs command every intervalS (bounded below by the status poll, ~30-60s);
  the LAST line of its stdout must contain seconds-since-last-progress (e.g. a
  SELECT now()-max(finished_at) or a stat of a progress file). Exit 0 + a number =
  measured; age > stalenessThresholdS = STALLED (re-alerts every further threshold of
  silence). Nonzero exit, timeout (15s), or non-numeric output = probe failure; 3
  consecutive failures fire LIVENESS PROBE FAILING — a broken probe is not a green light.
  Same tabId+label upserts.
  Response: { "tabId", "workspaceId", "probe" }

GET /api/cli/tabs/<tabId>/probe?workspaceId=WS
  Response: { "probes": [{ "label", "command", "stalenessThresholdS", "intervalS",
              "lastRunAt", "lastAgeS", "stale", "consecutiveFailures", "lastError" }] }

DELETE /api/cli/tabs/<tabId>/probe?workspaceId=WS[&label=L]
  Remove probes (all for the tab, or one label). Do this when the job completes.
  Response: { "removed": n }

POST /api/cli/tabs/<tabId>/bg?workspaceId=WS
  Body: { "pid": N, "label"?: "...", "stderrFile"?: "/abs/path", "exitCodeFile"?: "/abs/path" }
  Watch a background pid; when it exits, BACKGROUND JOB DIED fires with the exit code
  (read from exitCodeFile) and the stderr tail (last ~10 lines of stderrFile). Launch
  pattern that captures both:  ( cmd 2>/tmp/job.err; echo $? > /tmp/job.exit ) & — then
  register the subshell pid. The registration is one-shot: it is dropped after the
  death notification.
  Response: { "tabId", "workspaceId", "job" }

GET /api/cli/tabs/<tabId>/bg?workspaceId=WS
  Response: { "backgroundJobs": [{ "pid", "label", "alive", "registeredAt", "ageS" }] }

DELETE /api/cli/tabs/<tabId>/bg?workspaceId=WS[&pid=N]
  Stop watching (all for the tab, or one pid).
  Response: { "removed": n }

## Orchestration

GET /api/cli/workspaces/<workspaceId>/orchestration
  Response: { "orchestration": { "enabled", "orchestratorTabId", "kickoffTemplate"? }, "nudges": [...] }

PATCH /api/cli/workspaces/<workspaceId>/orchestration
  Body: { "enabled"?: boolean, "orchestratorTabId"?: string | null, "kickoffTemplate"?: string | null }
  Orchestrators use this to designate themselves (enabled + own tabId) and to turn
  orchestration off when the epic is finished — this stops watchdog nudges and idle
  heartbeats for the workspace.

## Standup ticks

POST /api/cli/workspaces/<workspaceId>/standup
  Body: { "state": "on-track" | "at-risk" | "blocked" | "awaiting-human" | "done",
          "headline": "<one line: where things stand>",
          "items"?: [{ "label", "status": "done" | "active" | "blocked" | "todo", "note"? }],
          "blockers"?: [{ "what", "needs": "<the exact input that clears it>" }],
          "needsHuman"?: boolean, "next"?: ["<upcoming step>"] }
  Orchestrators post one after every nudge they handle and on every heartbeat. The
  latest tick renders in the workspace sidebar — it is how the human reads progress,
  blockers, and whether they are needed, without opening any pane. "state" and
  "headline" are required; everything else may be omitted.

GET /api/cli/workspaces/<workspaceId>/standup
  Response: { "latest": { ... } | null, "history": [...] }

## Web-browser tabs

These endpoints only work when the tab's panelType is "web-browser" and the webview
has attached (dom-ready has fired at least once). Electron runtime required;
503 is returned in headless/remote mode.

GET /api/cli/tabs/<tabId>/browser/url?workspaceId=WS
  Current URL + title of the webview.
  Response: { "tabId", "url", "title" }

GET /api/cli/tabs/<tabId>/browser/screenshot?workspaceId=WS[&full=1][&format=base64]
  PNG screenshot. Default returns image/png; format=base64 returns { base64 } JSON.
  full=1 captures beyond the viewport.

GET /api/cli/tabs/<tabId>/browser/console?workspaceId=WS[&since=MS][&level=LEVEL]
  Ring buffer (last 500 entries) of console messages, Log entries, and exceptions.
  Response: { "tabId", "entries": [{ "level", "text", "ts", "source"?, "url"?, "line"? }] }

GET /api/cli/tabs/<tabId>/browser/network?workspaceId=WS[&since=MS][&method=M][&url=SUBSTR][&status=CODE]
  Ring buffer (last 500 requests).
  Response: { "tabId", "entries": [{ "requestId", "method", "url", "status"?, "mimeType"?,
                                     "resourceType"?, "error"?, "ts", "endedAt"? }] }

GET /api/cli/tabs/<tabId>/browser/network?workspaceId=WS&requestId=RID
  Fetch response body for one request (cached after first call).
  Response: { "tabId", "requestId", "body" }

POST /api/cli/tabs/<tabId>/browser/eval?workspaceId=WS
  Body: { "expression": "..." }
  Evaluates the expression in the webview via CDP Runtime.evaluate
  (returnByValue, awaitPromise, 10s timeout).
  Response: { "tabId", "value" }
`;

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!verifyCliToken(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  return res.status(200).send(GUIDE);
};

export default handler;
