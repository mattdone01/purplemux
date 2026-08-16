# ADR-0005: Grok Build is the third agent provider; transcripts come from its ACP JSONL; per-workspace isolation via `GROK_HOME`

_Epic decision id: ADR-010, revised (see `_output/purplemux-mobile/architecture.md`)._

## Status
Accepted (2026-08-16, epic `purplemux-mobile`, stories 19–21, **revised the same day** and delivered by story 25).

The first draft of this ADR targeted the community `superagent-ai/grok-cli` (npm `grok-dev`): API-key billing, SQLite transcripts read through `node:sqlite`, hooks merged into `~/.grok/user-settings.json`, and no isolation. That tool is now **parked and disabled** at `~/.grok-oss/` and is not supported.

## Context
The user wants a subscription-billed Grok agent, the way Claude Max and ChatGPT-for-Codex are billed — not an API key.

**Grok Build** is that: xAI's official CLI (`https://x.ai/build`, `curl -fsSL https://x.ai/cli/install.sh | bash`), v1.0.4 installed at `~/.grok/bin/grok` and also linked as `agent`. Facts read from its bundled docs (`~/.grok/docs/user-guide/*.md`) and from two sessions recorded on this machine:

- **Auth** — browser OAuth at `auth.x.ai`, `grok login [--oauth | --device-auth]`, tokens in `~/.grok/auth.json` (0600). `XAI_API_KEY` is the fallback when no session token exists.
- **Sessions** — `$GROK_HOME/sessions/<url-encoded cwd>/<uuidv7>/` holding `summary.json`, `updates.jsonl` (the authoritative ACP session-update stream), `signals.json`, `events.jsonl`, `chat_history.jsonl`, `rewind_points.jsonl`. **JSONL, not a database.**
- **Hooks** — JSON files in `$GROK_HOME/hooks/*.json`, in the Claude Code hooks format; the payload is JSON on stdin with camelCase keys and a snake_case `hookEventName` value.
- **`GROK_HOME`** overrides `~/.grok` for sessions, hooks, rules and config — the exact counterpart of `CLAUDE_CONFIG_DIR`.
- **`[compat.claude]`** (on by default) makes grok read `~/.claude/{CLAUDE.md,commands,skills,rules,agents}`, keyed on `$HOME`, so it keeps working under a custom `GROK_HOME`.
- **Cost is reported.** `turn_completed.usage.costUsdTicks` is USD × 10^10; a headless run printing both `total_cost_usd 0.01009732` and `total_cost_usd_ticks 100973200` fixes the scale.

purplemux already abstracts providers (`IAgentProvider`, `src/lib/providers/{claude,codex}`) and its transcript pipeline is built for JSONL files (`isAllowedJsonlPath`, `fs.watch`, incremental parse).

## Options

1. **Community grok-cli as the provider** (the first draft) — API-key billing the user does not want, a SQLite transcript source that fits nothing else in the pipeline, no `GROK_HOME`, and a skills generator into `~/.agents/skills`. Rejected and parked.
2. **Grok Build as the provider** — subscription auth; JSONL sessions fit the existing watch/parse pipeline; Claude-format hooks fit `hook-settings.ts`; `GROK_HOME` gives the same isolation shape as `CLAUDE_CONFIG_DIR`; the SDLC skill library needs no port. Cost: an ACP-update parser (`session-parser-grok.ts`) and the UI fan-out.
3. **Both providers** — two `grok` panel types for two tools that share a binary name and a home directory; double the surface for no user value. Rejected: the community tool stays an installed-but-disabled option only.

## Decision
Option 2.

- **Transcripts** — `session-parser-grok.ts` reads `updates.jsonl`. Each line is `{timestamp, method: "session/update" | "_x.ai/session/update", params:{sessionId, update:{sessionUpdate, …}}}`. Chunks stream, so consecutive chunks of one kind collapse into one entry; `seq` is the ordinal of the first update line that produced the entry and `id` is `grok:<sessionId>:<seq>`.
- **Isolation** — a pane in workspace `<ws>` launches with `GROK_HOME=~/.purplemux/workspaces/<ws>/grok-home`, built by `src/lib/grok-home.ts`: `sessions/`, `hooks/` and `logs/` are private; `auth.json`, `config.toml`, `skills/`, `commands/`, `rules/`, `memory/`, `agents/`, `plugins/`, `trusted_folders.toml` and `mcp_credentials.json` are symlinked back to `~/.grok`. Ad-hoc tabs use the real `~/.grok`.
- **Session key** — `grok:<wsId|global>:<sessionId>`. The workspace comes from the `GROK_HOME` the transcript sits under, never from its cwd, and `sessionScopeFor` is the single derivation the socket, `sessions-v2` and search all ask.
- **Hooks** — `ensureHookSettings` writes `$GROK_HOME/hooks/purplemux.json` in every grok home, and `tmux.ts` writes it again for a workspace created after boot. purplemux owns that one file and never touches a sibling. It registers the five events `10-hooks.md` calls a complete busy/idle indicator (`UserPromptSubmit`, `Stop`, `StopFailure`, `StopCancelled`, `Notification idle_prompt`) plus compaction, teardown and `PostToolUse`.
- **Usage** — `byProvider.grok` is summed from `turn_completed` updates: tokens, cache reads and a real `totalCost`. `signals.json` carries counts but no token or spend totals, so it is not the source for them.

## Consequences
`TPanelType` and `agentProviderId` keep their `grok-cli`/`grok` values, and the whole UI fan-out from story 19 is unchanged — the migration is internal. `isAllowedJsonlPath` gains the two `$GROK_HOME/sessions/**` roots. grok exposes no rate-limit windows (it is a subscription), so there is no `rate-limits.json` entry for it. `node:sqlite` is gone from the codebase. The human must run `grok login` (or `--device-auth` on a headless box) once per machine; the preflight surfaces that as its own blocker rather than as "not installed". The parked community tool must not be run concurrently without a separate `HOME`/`GROK_HOME` — documented in `~/.grok-oss/README.md`.

**Grok Build is an early beta.** The provider is pinned to the tested version, 1.0.4; `src/lib/providers/grok/README.md` records what was verified against a recording and what was read from the docs alone.

Source of truth for the epic: `_output/purplemux-mobile/architecture.md` (nomupay workspace). Related: `research.md` "API contract".
