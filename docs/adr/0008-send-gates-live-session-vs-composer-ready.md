# ADR-0008: two send gates — a person's client needs a live session, an unattended dispatcher needs a composer

_Epic story: 32 (see `_output/purplemux-mobile/stories/32-phone-is-a-peer-not-a-viewer.md`)._

## Status
Accepted (2026-08-17, epic `purplemux-mobile`, story 32). Narrows ADR-0007's scope; ADR-0007 stands for the CLI route.

## Context
ADR-0003 gave the cookie-authed `POST /api/tabs/{tabId}/send` the same composer gate the CLI route later took in ADR-0007: `SENDABLE_STATES` was `{idle, ready-for-review, needs-input}` and every other `cliState` got a 409. `busy` was in "every other state".

An orchestrator is busy almost by definition, so that rule stopped the phone reaching the one tab a person outside the house most wants to reach. The reported symptom was not "it refused me" — it was *"is it in some kind of readonly mode?"*, because the chat face closed its input bar and said nothing a reader could act on.

The rule was also stricter than every other client of the same server:

| Client | Route | `cliState` gate |
|---|---|---|
| web app | `POST /api/tmux/send-input` | none |
| phone, terminal face | `POST /api/tmux/send-input` | none |
| phone, chat face | `POST /api/tabs/{id}/send` | composer-ready |
| `purplemux tab send` | `POST /api/cli/tabs/{id}/send` | composer-ready, with a wait |

An agent TUI queues a prompt that arrives mid-turn; the human has driven busy tabs from the web app all along, and every worker in this epic was briefed by `purplemux tab send` into a busy tab. Only the phone's chat face was crippled, and only because one constant was shared by two callers who wanted different things from it.

## Options

1. **Point the chat face at `/api/tmux/send-input`.** Dodges the gate by leaving the route. Loses cookie auth scoping, tab resolution, the `submit:false` paste path, and the `submitted` verdict. Rejected: the endpoint earns its place — the gate was the defect.
2. **Add `busy` to `SENDABLE_STATES`.** Fixes the reported case and nothing else. `inactive` and `unknown` are equally live and equally sendable, and the CLI route would silently stop waiting for a booting agent — that is ADR-0007 undone by a one-line edit, which is exactly how it would be undone.
3. **Split the question in two.** `awaitSendReadiness` takes a `gate`: `live-session` asks "is there something on the other end?", `composer-ready` additionally holds for a composer. The cookie route takes `live-session`, the CLI route takes `composer-ready`.

## Decision
Option 3. `TSendGate` in `src/lib/tab-send.ts` is the single place the distinction is stated, and the gate is a required field of `ISendReadinessRequest`, so a future caller has to choose rather than inherit.

The distinction is **boot-race versus mid-turn**, not caution versus recklessness:

- A brief dispatched by `purplemux tab send` the instant a tab is created races the TUI's boot. Nobody is watching, the swallowed Enter produces no signal, and the tab sits for fifty minutes. That caller waits — ADR-0007 unchanged, `waitMs` unchanged, "nothing is pasted on timeout" unchanged.
- A person typing into a chat box is watching the screen. If the Enter is swallowed, `submitted: false` comes straight back and the phone offers a "Press Enter" button. Waiting would buy that caller nothing and cost it the entire product thesis.

Both gates still refuse a tab that is gone (404) and a tmux session that is not running (409, `detail: 'session-not-running'`). That is not policy — there is no recipient.

## Consequences
`POST /api/tabs/{tabId}/send` now answers 409 for exactly one reason, and its `detail` is always `session-not-running`; a client can treat the 409 as "this tab is dead" rather than "try later". `busy` sends return 200 with `submitted` reporting whether the agent took the Enter, which is the honest answer and the one the phone already renders.

Sending to an `inactive` tab pastes into whatever holds the pane, usually a shell. That is what the web client and the phone's terminal face have always done to the same tab; the phone's chat face no longer differs from them.

`isSendableCliState` was renamed `isComposerReadyCliState`. The old name read as a permission and was acted on as one.

Source of truth for the epic: `_output/purplemux-mobile/architecture.md` (nomupay workspace).
