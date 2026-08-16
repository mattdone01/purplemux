# Grok provider (Grok Build)

The provider targets **Grok Build 1.0.4** — xAI's official CLI, installed by
`curl -fsSL https://x.ai/cli/install.sh | bash` at `~/.grok/bin/grok` (also
linked as `agent`). Its bundled documentation is at `~/.grok/docs/user-guide/`.

The community `superagent-ai/grok-cli` (npm `grok-dev`) is **not supported**. It
builds a binary of the same name and uses the same `~/.grok` directory, so
running both at once needs a separate `HOME`/`GROK_HOME`. See ADR-0005.

## What lives where

| Module | Responsibility |
|---|---|
| `paths.ts` | `~/.grok` layout constants; session-id and home resolution from a transcript path |
| `session-store.ts` | reads session directories, `summary.json` and `signals.json` across every grok home |
| `session-detection.ts` | finds the running `grok` process and binds it to a session directory |
| `hook-config.ts` | builds and writes `$GROK_HOME/hooks/purplemux.json` |
| `hook-payload.ts` | translates the camelCase stdin envelope into purplemux work-state events |
| `hook-handler.ts` | the `/api/status/hook?provider=grok` translation, including the idle-settle rule |
| `preflight.ts` | `grok --version`, binary resolution, and the `auth.json` / `XAI_API_KEY` login check |
| `runtime-snapshot.ts` | derives `idle` / `currentAction` / last assistant snippet from the transcript |
| `../../session-parser-grok.ts` | the ACP `updates.jsonl` parser (lives with the other parsers) |
| `../../grok-home.ts` | per-workspace `GROK_HOME` provisioning |

## Isolation

A workspace pane launches with `GROK_HOME=~/.purplemux/workspaces/<ws>/grok-home`.
`sessions/`, `hooks/` and `logs/` are real directories, private to the workspace;
`auth.json`, `config.toml`, `skills/`, `commands/`, `rules/`, `memory/`,
`agents/`, `plugins/`, `trusted_folders.toml` and `mcp_credentials.json` are
symlinks back to `~/.grok`. An ad-hoc tab runs against the real `~/.grok`, and
its sessions key as `grok:global:<id>`.

purplemux never writes `~/.grok/config.toml`, and never changes the
`[compat.claude]` cells — they are how the SDLC skill library reaches Grok.

## What is verified, and what is not

Recorded from two real sessions on this machine (2026-08-16), and kept in
`tests/fixtures/grok-session/` and `tests/fixtures/grok-session-tools/`:

- the `updates.jsonl` line envelope, on both the `session/update` and
  `_x.ai/session/update` channels;
- `user_message_chunk`, `agent_thought_chunk`, `agent_message_chunk` and their
  streaming behaviour;
- `tool_call` and `tool_call_update`, including the non-terminal update that
  only refines a call's title, and the `_meta['x.ai/tool']` block that names the
  tool;
- `turn_completed` usage, and that `costUsdTicks` is USD × 10^10;
- `summary.json` and `signals.json` field names.

Read from the documentation but **not** yet seen in a recording, and therefore
handled defensively rather than asserted:

- a compaction `sessionUpdate` kind — none was observed, so the parser emits no
  `context-compacted` entry and simply ignores kinds it does not know;
- the `plan` update kind (`15-agent-mode.md`) — ignored for the same reason;
- `subagents/` — the parser produces no `agent-group` entry yet, and the hook
  translator deliberately drops every event carrying `subagentType` so a
  subagent's stop cannot settle the parent tab.

Adding any of these is a matter of recording a session that contains one and
writing the branch against it.
