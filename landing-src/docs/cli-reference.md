---
title: CLI reference
description: Every subcommand and flag of the purplemux and pmux binaries.
eyebrow: Reference
permalink: /docs/cli-reference/index.html
---
{% from "docs/callouts.njk" import callout %}

`purplemux` ships with two ways to use the binary: as a server starter (`purplemux` / `purplemux start`) and as an HTTP API wrapper (`purplemux <subcommand>`) that talks to a running server. The short alias `pmux` is identical.

## Two roles, one binary

| Form | What it does |
|---|---|
| `purplemux` | Start the server. Same as `purplemux start`. |
| `purplemux <subcommand>` | Talk to a running server's CLI HTTP API. |
| `pmux ...` | Alias for `purplemux ...`. |

The dispatcher in `bin/purplemux.js` peels off the first argument: known subcommands route to `bin/cli.js`, anything else (or no argument) launches the server.

## Starting the server

```bash
purplemux              # default
purplemux start        # same thing, explicit
PORT=9000 purplemux    # custom port
HOST=all purplemux     # bind everywhere
```

See [Ports & env vars](/purplemux/docs/ports-env-vars/) for the full env surface.

The server prints its bound URLs, mode, and auth status:

```
  ⚡ purplemux  v0.x.x
  ➜  Available on:
       http://127.0.0.1:8022
       http://192.168.1.42:8022
  ➜  Mode:   production
  ➜  Auth:   configured
```

If `8022` is already in use the server warns and binds to a random free port instead.

## Subcommands

All subcommands require a running server. They read the port from `~/.purplemux/port` and the auth token from `~/.purplemux/cli-token`, both written automatically at server startup.

| Command | Purpose |
|---|---|
| `purplemux workspaces` | List workspaces |
| `purplemux tab list [-w WS]` | List tabs (optionally scoped to a workspace) |
| `purplemux tab create -w WS [-n NAME] [-t TYPE]` | Create a new tab |
| `purplemux tab send -w WS TAB_ID CONTENT...` | Send input to a tab. Waits up to 60s for an agent tab to be able to accept a turn (`--wait-ms N`, `--no-wait`); on timeout nothing is pasted |
| `purplemux tab status -w WS TAB_ID` | Inspect a tab's status |
| `purplemux tab result -w WS TAB_ID` | Capture the tab pane's current content |
| `purplemux tab close -w WS TAB_ID` | Close a tab |
| `purplemux tab browser ...` | Drive a `web-browser` tab (Electron only) |
| `purplemux api-guide` | Print the full HTTP API reference |
| `purplemux help` | Show usage |

Output is JSON unless noted. `--workspace` and `-w` are interchangeable.

### `tab create` panel types

The `-t` / `--type` flag picks the panel type. Valid values:

| Value | Panel |
|---|---|
| `terminal` | Plain shell |
| `claude-code` | Shell with `claude` already running |
| `web-browser` | Embedded browser (Electron only) |
| `diff` | Git diff panel |

Without `-t`, you get a plain terminal.

### `tab browser` subcommands

These only work when the tab's panel type is `web-browser`, and only in the macOS Electron app — the bridge returns 503 otherwise.

| Subcommand | What it returns |
|---|---|
| `purplemux tab browser url -w WS TAB_ID` | Current URL + page title |
| `purplemux tab browser screenshot -w WS TAB_ID [-o FILE] [--full]` | PNG. With `-o` saves to disk; without, returns base64. `--full` captures the full page. |
| `purplemux tab browser console -w WS TAB_ID [--since MS] [--level LEVEL]` | Recent console entries (ring buffer, 500 entries) |
| `purplemux tab browser network -w WS TAB_ID [--since MS] [--method M] [--url SUBSTR] [--status CODE] [--request ID]` | Recent network entries; `--request ID` fetches one body |
| `purplemux tab browser eval -w WS TAB_ID EXPR` | Evaluate a JS expression and serialize the result |

## Examples

```bash
# Find your workspace
purplemux workspaces

# Create a Claude tab in workspace ws-MMKl07
purplemux tab create -w ws-MMKl07 -t claude-code -n "refactor auth"

# Send a prompt to it (TAB_ID comes from `tab list`)
purplemux tab send -w ws-MMKl07 tb-abc "Refactor src/lib/auth.ts to remove the cookie path"

# Watch its state
purplemux tab status -w ws-MMKl07 tb-abc

# Snapshot the pane
purplemux tab result -w ws-MMKl07 tb-abc

# Screenshot a web-browser tab full-page
purplemux tab browser screenshot -w ws-MMKl07 tb-xyz -o page.png --full
```

## Authentication

Every subcommand sends `x-pmux-token: $(cat ~/.purplemux/cli-token)` and is verified server-side via `timingSafeEqual`. The `~/.purplemux/cli-token` file is generated on first server start with `randomBytes(32)` and stored mode `0600`.

If you need to drive the CLI from another shell or a script that can't see `~/.purplemux/`, set the env vars instead:

| Variable | Default | Effect |
|---|---|---|
| `PMUX_PORT` | contents of `~/.purplemux/port` | Port the CLI talks to |
| `PMUX_TOKEN` | contents of `~/.purplemux/cli-token` | Bearer token sent as `x-pmux-token` |

```bash
PMUX_PORT=8022 PMUX_TOKEN=$(cat ~/.purplemux/cli-token) purplemux workspaces
```

{% call callout('warning') %}
The CLI token grants full server access. Treat it like a password. Don't paste it into chat, commit it, or expose it as a build env var. Rotate by deleting `~/.purplemux/cli-token` and restarting the server.
{% endcall %}

## update-notifier

`purplemux` checks npm for a newer version on every launch (via `update-notifier`) and prints a banner if one exists. Disable with `NO_UPDATE_NOTIFIER=1` or any of the [standard `update-notifier` opt-outs](https://github.com/yeoman/update-notifier#user-settings).

## Full HTTP API

`purplemux api-guide` prints the complete HTTP API reference for every `/api/cli/*` endpoint, including request bodies and response shapes — useful when you want to drive purplemux directly from `curl` or another runtime.

## What's next

- **[Ports & env vars](/purplemux/docs/ports-env-vars/)** — `PMUX_PORT` / `PMUX_TOKEN` in the broader env surface.
- **[Architecture](/purplemux/docs/architecture/)** — what the CLI is actually talking to.
- **[Troubleshooting](/purplemux/docs/troubleshooting/)** — when the CLI says "is the server running?".
