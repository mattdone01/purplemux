# ADR-0007: `POST /api/cli/tabs/{id}/send` holds for a bounded readiness window and pastes nothing when it expires

_Epic story: 22 (see `_output/purplemux-mobile/stories/22-cli-send-readiness-gate.md`)._

## Status
Accepted (2026-08-16, epic `purplemux-mobile`, story 22)

## Context
 `purplemux tab send` delivers with `sendBracketedPaste` — bracketed paste, then Enter — and answered `{"status":"sent","submitted":true}` unconditionally. An agent TUI that is still booting has no composer bound yet: the paste lands in the input box and the Enter is swallowed. On 2026-08-16 three worker tabs of this epic (stories 06, 07, 09) sat in exactly that state for ~50 minutes of wall-clock. Each call reported success, each tab reported `cliState: busy`, and a tab that never starts never changes state, so no downstream signal existed. Recovery was a manual `tmux send-keys -t <session> Enter`. ADR-0003 already built the gate for the cookie-authed twin (`agent-not-ready`, `detail: 'session-not-running'`), but the CLI route — the one orchestrators drive — had none.

## Options

1. **Refuse immediately when the tab is not sendable**, exactly like the cookie route. Correct but hostile to the dominant caller: an orchestrator that creates a tab and dispatches its brief must now write its own poll loop, and every orchestrator writes a different one.
2. **Paste, then press Enter again (or sleep a fixed interval before pasting).** Converts a deterministic failure into an intermittent one, and a second Enter on an agent that DID accept the turn submits an empty prompt. Rejected.
3. **Hold for a bounded readiness window (`waitMs`, default 60 s, `0` = answer now), re-resolving the tab on every poll, and paste nothing if the window expires.** One readiness definition — `awaitSendReadiness` in `src/lib/tab-send.ts` — serves both routes; the cookie route calls it with `timeoutMs: 0` so the phone still gets an immediate verdict.

## Decision
 Option 3. The gate keys on `cliState` plus `isAgentPanelType`, never on a provider list, so grok-cli (ADR-0005) and any fourth provider are covered by construction. A dead tmux session is checked before the composer gate, so it is diagnosed at once instead of waiting out the deadline. **Nothing is pasted on timeout**: half a brief parked in a composer, waiting for someone else's Enter, is worse than no brief — it is the original failure with extra steps.

## Consequences
 `submitted: true` from either send route now means an agent that could accept a turn was pasted into and the composer came back empty. A `tab send` can block for up to `waitMs` (`--wait-ms N` / `--no-wait` on the CLI); the 409 body names the tab, its `cliState`, and `detail: 'readiness-timeout' | 'session-not-running'`. Terminal, browser and diff tabs are ungated — they have no turn to accept — which also lifts the cookie route's accidental block on sending to a terminal tab.

Source of truth for the epic: `_output/purplemux-mobile/architecture.md` (nomupay workspace).
