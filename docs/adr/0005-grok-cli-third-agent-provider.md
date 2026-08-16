# ADR-0005: grok-cli is the third agent provider; transcripts come from its SQLite store via `node:sqlite`; no per-workspace isolation in v1

_Epic decision id: ADR-010 (see `_output/purplemux-mobile/architecture.md`)._

## Status
Accepted (2026-08-16, epic `purplemux-mobile`, stories 19–21)

## Context
 grok-cli 1.1.7 (superagent-ai/grok-cli, npm `grok-dev`) installed at `~/.grok/bin/grok`. Facts read from source: Claude-Code-shaped hooks configured in `~/.grok/user-settings.json` (JSON on stdin, `hook_event_name`, `session_id`, `cwd`); transcripts in `~/.grok/grok.db` (`messages(session_id, seq, role, message_json)`, `tool_calls`, `tool_results`, `usage_events(model, input/output/total_tokens, cost_micros)`, `compactions`) — **not JSONL**; `~/.grok` path hard-coded (no `CLAUDE_CONFIG_DIR` analogue); skills at `~/.agents/skills/<name>/SKILL.md` (name+description frontmatter, same as Codex); global instructions `~/.grok/AGENTS.md`; no rate-limit windows exposed. purplemux already abstracts providers (`IAgentProvider`, `src/lib/providers/{claude,codex}`) and its transcript pipeline assumes JSONL files (`isAllowedJsonlPath`, `fs.watch`).

## Options

1. **Terminal-only grok tabs** (a `terminal` tab that happens to run `grok`) — zero work, but no cliState, no timeline/chat face, no alerts, no usage: it is not "an AI interface", it is a shell.
2. **Full provider via the existing abstraction, transcripts read from grok's SQLite with `node:sqlite` (Node 22.23 on ai-server; read-only), hooks merged into `user-settings.json`, usage from `usage_events`, `sessionKey = grok:global:<id>`, ids `grok:<sid>:<seq>` with grok's native `seq`.** Cost: an 8-point story plus UI fan-out; the JSONL-shaped code paths get a second transcript source behind the provider interface. Benefit: grok tabs are peers of Claude/Codex tabs everywhere (status, timeline, alerts, stats, mobile).
3. **Wrap grok in `--format json` headless mode** driven by purplemux (NDJSON events) — loses the TUI the user actually wants in the terminal face, and duplicates a chat runtime. Rejected.

## Decision
 Option 2. **Isolation:** grok has no config-dir override, so v1 shares one `~/.grok` across workspaces (grok keys sessions by cwd itself); revisit if grok adds an env override or if per-workspace API keys become a need. **Skills:** the engineering skills library gains a `grok` build target + `install.sh --grok` (`~/.agents/skills`, `~/.grok/AGENTS.md`).

## Consequences
 `TPanelType` + `agentProviderId` gain `grok-cli`/`grok` additively; the history/search routes gain a grok branch (DB, not path); mobile adds an enum value + badge + third usage tile; the `node:sqlite` experimental warning is accepted and isolated in one module; API key configuration is per machine (`GROK_API_KEY` or `~/.grok/user-settings.json.apiKey`) — a human step.

Source of truth for the epic: `_output/purplemux-mobile/architecture.md` (nomupay workspace). Related: `research.md` "API contract".
