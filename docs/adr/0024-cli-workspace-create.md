# ADR-0024: Workspace creation from the CLI — admin token only

## Status
Accepted (2026-10-20). Owner request, 2026-10-20: "Let add a workspace create."

## Context
Only the web UI could create a workspace: `POST /api/workspace` requires a human session cookie and a same-origin request, and the proxy refuses the global token on `/api/workspace` writes (ADR-0021). An architect that moves an epic to a new repository must then ask the owner to click through the UI before it can start work there.

ADR-0021 says that agent tab and workspace mutations need a token scoped to the target workspace, and that the global token cannot authorize them. A new workspace has no token yet, so that rule cannot apply to creation as written. A workspace or tab token that could create workspaces would let any agent mint workspaces that it then cannot use, and would widen agent authority past its own workspace.

## Options
1. Keep creation human-only. The agent asks the owner for every new workspace.
2. Let any valid CLI token create a workspace.
3. Let only the host's admin token (`~/.purplemux/cli-token`) create a workspace, through a new `POST /api/cli/workspaces`.

## Decision
Option 3.

- `POST /api/cli/workspaces { name, directories }` accepts only the admin scope. A workspace or tab token gets 403 `forbidden`. The CLI keeps its token order (`PMUX_TAB_TOKEN` > `PMUX_TOKEN` > the global token): inside a tab it presents the tab's own token, so the call is refused there. A caller runs it from a shell outside every tab, or unsets both tab variables on purpose.
- The route calls the same `createWorkspace` store function and the same default-tab registration (`src/lib/workspace-default-tab.ts`) as the UI route. The result is the same: the registry entry, the first tab and its tmux session, and the per-workspace agent homes that the session start builds.
- The CLI path is stricter than the UI path. The name is required and unique (trimmed, case-insensitive), checked under the store lock. Every directory must be an existing absolute directory, and nothing is created. The UI path keeps its old behaviour.
- Each creation appends one `workspace-create` line to `~/.purplemux/audit/coordination.jsonl`.
- Like every admin-token authority (ADR-0019), this is cooperative, not a security boundary: any process of this Unix user can read the token file.

## Consequences
- An agent creates a workspace only by a deliberate step outside its tab identity. That step is visible in the audit file.
- Tab, orchestration and directory changes inside the new workspace still need that workspace's own token (ADR-0021). The admin caller's CLI finds it on disk through `-w`; an agent inside another workspace's tab cannot use it.
- Workspace deletion stays human-only.
