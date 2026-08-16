# ADR-0003: Phone authenticates with the purplemux password only; server gains a cookie-authed prompt-send route; the CLI token never leaves the box

_Epic decision id: ADR-004 (see `_output/purplemux-mobile/architecture.md`)._

## Status
Accepted (2026-08-16, epic `purplemux-mobile`)

## Context
 WS auth is cookie-only (`server.ts:37-41`); `x-pmux-token` short-circuits the proxy for HTTP (`src/proxy.ts:12-15`) but `/api/cli/**` is token-only with workspace scoping and its `send` route deliberately rejects the global token for input injection in some paths (`cli-utils.ts:50-51,88-109`). NFR-6. Research Q5.

## Options

1. **Ship the CLI token to the phone** — one secret that also authorises `purplemux tab send` into any workspace and bypasses the proxy for every route; losing the phone = losing the box. Rejected.
2. **Add Bearer/`?token=` auth to WebSockets** — a server change purely to avoid a cookie jar; widens the WS attack surface; the web client would not use it. Rejected.
3. **Password → `session-token` cookie (7 d, sliding renewal on any response), stored in Android-Keystore-backed secure storage; optional remembered password for silent re-login after `authSecret` rotation; a new cookie-authed `POST /api/tabs/{tabId}/send` wrapping the same `sendBracketedPaste` + `isContentPendingInComposer` chain as the CLI route.** 

## Decision
 Option 3.

## Consequences
 every WS handshake carries `Cookie: session-token=<jwt>` (Dart `dart:io WebSocket.connect(headers:)`); 401 → re-login; changing the password on the desktop logs the phone out (documented); the chat face needs no terminal socket (research Q5); the lesson "sent ≠ started" is enforced client-side by re-checking `cliState` and offering a bare Enter via `POST /api/tmux/send-input`.

_Server-side half of the decision; the client half lives in purplemux-mobile ADR-0003._

Source of truth for the epic: `_output/purplemux-mobile/architecture.md` (nomupay workspace). Related: `research.md` "API contract".
