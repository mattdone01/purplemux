# ADR-0050: messages reach a busy Claude tab: a typed queue, and a directory for SendMessage

## Status
Accepted (2026-11-20). One architect design consult (Opus 5.5 xhigh): `APPROVE-WITH-CHANGES`, option 4 with four
changes. Amendment 1 of that ruling, after the owner chose sockets for Claude-to-Claude messages: S1, purplemux as the
directory. The owner's ruling of 20 Nov 2026 on lead pairs replaces the amendment's refusal of lead-to-lead lookups
between workspaces. Amends ADR-0012 and ADR-0013 (below).

## Context
A `purplemux tab send` to a busy Claude Code tab waited up to 60 s for an empty composer, then exited 5
(`readiness-timeout`) with nothing queued. Every sender had to retry, and a coordinator that a nudge kept busy at
every turn end never got the text. The goal:

1. A send (and a note delivery) to a busy Claude tab does not fail with exit 5 and needs no retry. The text arrives
   during the running turn, between two tool calls, or at the latest at the turn end.
2. The sender reads one delivery state per message: `queued`, `delivered`, `held`, `refused`, `expired`.
3. A message can carry a supersede key: a newer message with the same key for the same target replaces an older one
   that the target has not read.
4. Idle tabs, terminal tabs and other CLIs (Codex, Grok) keep working as before. Workspace walls and every existing
   refusal stay.

## Feasibility findings (Claude Code 2.1.328 and 2.1.329)
- **A process that is not a Claude session cannot write to a session's inbox socket on a documented interface.** The
  cross-session messaging page documents the socket path (`CLAUDE_CODE_MESSAGING_SOCKET`, exported to hooks and Bash
  commands) and an optional auth line, but not the message line. Three obvious line shapes posted by the session's own
  child process delivered nothing. A sender the session cannot verify as its own child is held for approval by a
  session that skips permission prompts. So the server does not write to sockets (option 1 rejected).
- **Hook `additionalContext` reaches the model mid-turn, but the model treats it as untrusted.** PostToolUse and
  PostToolBatch text arrived before the next model request in two scratch runs; in both, the model declined to act on
  it. A drain would also add a synchronous round trip to every matched tool call of every seat (option 2 not built).
- **Text typed into a busy Claude composer is held and read mid-turn.** Measured in a scratch interactive session
  (real-session test RS-1, 3 of 3): the composer reads empty while busy; the typed header and body leave the composer
  at once ("Queued"); Claude Code hands them to the model after the next tool call (a `queued_command` attachment in
  the transcript); the model acted on the body and continued its turn. purplemux's own screen readers read that
  screen as an empty composer and the text as not pending.
- **SendMessage between two Claude sessions works mid-turn, and the receiver acts.** Measured (RS-5): session A sent to
  `uds:<B's socket path>` while B ran a multi-tool turn; A got `success` ("in that session's inbox, not yet read"); B got
  the message after its next tool call and acted on it.
- **A received message fires `UserPromptSubmit`** on the receiver, with the prompt wrapped in
  `<cross-session-message from=…>` (RS-9, measured), and the hook input carries `permission_mode`.

## Decision

### 1. The typed queue (the fallback every S1 refusal names)
1. A `tab send` from a workspace token to a `claude-code` tab of the same workspace that is busy (not waiting at its
   prompt), not ready by `waitMs`, or that already holds a queued message, enqueues an inbox item of kind `message`
   and answers 200 `{status: "queued", submitted: false, messageId: "i-…", delivery: "queued"}` (exit 0). Nothing is
   typed. A tab that is ready with an empty queue is typed into at once, as before, and the answer adds
   `delivery: "delivered"` (or `"held"` with `notSubmitted`, exit 1 as before).
2. Unchanged, and no item: `tab-not-found` (exit 4), `session-not-running` (exit 4), `startup-prompt` (exit 5), the drive
   guard, the policy refusals, digest-class sends (ADR-0035), Codex, Grok and terminal tabs. These refusals are checked
   before the queue, so a message queued ahead never turns one of them into `queued`. A sender the drive guard admits
   from another workspace (the selected Scrum Master) keeps the old path: no body is queued across a wall. The item
   records the sender's own workspace, so the store and the dispatcher compare two independent values. A config store
   the route cannot read keeps the old path too.
3. The dispatcher types a `message` when the composer reads empty and the tab is idle, ready-for-review or busy. It never
   types into a permission prompt, a startup prompt, a compaction or a usage-limit halt. A `message` skips the
   coordinator window. Per target tab it waits only behind other messages (FIFO); notices keep their own order.
4. Inside the dispatch lock: claim the item under the store lock, read the tab's state again (a dialog that opened
   while the claim waited releases the claim; nothing was typed), check again that the sender workspace is the target
   workspace, then type one fixed header line `[purplemux message <id> from <ws>/<tab>, queued <time>]` and the body,
   unchanged. One more Enter if the text is still in the composer. A claim still on a queued item 2 min later (its
   outcome write failed) is held `transport-uncertain`, never expired and never typed again.
5. States: `queued` (route; covers backoff), `delivered` (typed and gone from the composer; not "read" or "obeyed"),
   `held` (still in the composer after the second Enter, a paste that threw, or a claim the server stopped during),
   `refused` (`superseded-by:<id>`, `target-tab-closed`, `target-changed`, `policy:<…>`, `workspace-mismatch`,
   `queue-off`), `expired` (TTL). `purplemux inbox show ID` reads one item. No reader serves a message body: inbox
   list and show, both retry routes and the coordination snapshot answer a view with the body's size only.
6. `--supersede KEY` (`[A-Za-z0-9._:-]{1,64}`): scope = target workspace + target tab + sender tab + key; it needs a
   sender tab (else 400, exit 2). Only queued, unclaimed items are superseded.
7. Notes: `note send --supersede KEY` refuses an older note of the same sender tab, recipient route and key that the
   recipient has not acked (`undeliverable`, `supersededBy`, final and no longer open). Its waiting line is withdrawn
   and fails the paste preflight. `note show` still serves its body. Note views gain an additive `delivery` field.
8. TTL 120 min (`--ttl-min 1..1440`); a held message stays visible until the 7-day prune. Cap: 20 queued messages per
   target tab (409 `message-queue-full`, exit 3). A closed tab refuses its items `target-tab-closed` (live and at boot);
   a replaced tmux session refuses `target-changed`; an exited agent in an open tab leaves the item queued until its
   TTL. A claimed item found at boot is held `transport-uncertain`, never typed again blind.
9. **Bodies do not outlive their use.** The store keeps a body only while the item may still be typed: queued, or held
   with no claim (a retry may queue it again). At every final state (delivered, refused, expired) and at every claimed
   hold, the store blanks the body in the same write.

### 2. S1: Claude-to-Claude by SendMessage, purplemux as the directory
1. **Registration.** The generic branch of the Claude status hook adds `socket` (only a path of the grammar
   `^/[A-Za-z0-9._/-]{1,106}\.sock$`) and `permissionMode` (a plain word) on `session-start`, `prompt-submit` and
   `notification`. It never reads the session's messaging token. Every hook runs the script the server rewrites at
   start, so a live seat registers at its next hook with no relaunch. hooks.json is unchanged.
2. **The directory** is in server memory only: one entry per tab (address `uds:<path>`, agent session, host, permission
   mode, `registeredAt`, `lastSeenAt`). The next registration replaces it; a tab close, an inactive agent, a stopped
   session or a stale lookup clears it. A restart empties it.
3. **Lookup:** `GET /api/cli/tabs/{tabId}/address` and `purplemux tab address [-w WS] TAB_ID`. Admitted exactly where
   `tab send` from the same caller passes the drive guard (its own workspace, or the selected Scrum Master), plus the
   lead-pair arm (below). Refusals, each with the hint "use `purplemux tab send`; it queues": `forbidden`,
   `caller-unresolved`, `address-not-claude`, `address-unknown`, `address-stale`, `address-other-host`,
   `address-class-mismatch` (the target skips permission prompts and the caller is known not to), `address-disabled`
   (exit 3); `tab-not-found`, `session-not-running` (exit 4). The stale check only stats the socket file and signals
   the pid in its name; the server never connects to a socket.
4. **The lead-pair arm** (the owner's ruling of 20 Nov 2026): between workspaces, a lookup is admitted exactly when the
   caller is the verified, enabled orchestrator tab of its own workspace and the target is the enabled orchestrator tab
   of its workspace (`IWorkspace.orchestration`, the same identity the WIP cap and the watchdog use), and every other
   condition above holds. A workspace with no enabled orchestrator has no lead. Any other lookup between workspaces is
   refused `address-not-lead-pair` (exit 3) with the hint "use `purplemux note send`; a note is the route between
   workspaces". This arm is the one place where the lookup admits more than `tab send` does.
5. **Audit:** one `address-lookup` coordination audit line per lookup, admitted, refused or failed (written in a
   `finally`): caller, target, scope (`same-workspace`, `scrum-master`, `lead-pair`, or none) and outcome. No address
   and no message body is logged; purplemux never sees a body. The audit is the control left for S1, so an admitted
   lookup whose line did not write is refused `address-audit-failed` (exit 3).
6. **A received message is no turn a send started.** The hook marks a prompt-submit whose prompt starts with the
   `<cross-session-message` wrapper `crossSession`, and the remote hook path reads the same wrapper from the prompt; it
   applies as a `fromTool` prompt-submit: the tab reads busy, but it is neither submit evidence for a `tab send` nor a
   new turn for `purplemux done`.
7. A send whose text starts with the `<cross-session-message` wrapper is read the same way, so it answers
   `notSubmitted` (exit 1) although it was typed. The API guide says so; a send must not start with the wrapper. This
   record adds no refusal for it.
8. **The seat prompt** gains one line after `tab send`: `purplemux tab address -w WS TAB_ID   # a Claude seat's
   SendMessage address; on any refusal or failed send use tab send (it queues); never message a socket you did not get
   here`, and one sentence: a lead may look up another workspace's lead; any other seat uses a note across workspaces.
9. **Seat rules** (prompt and this record): after `ENOENT`, one fresh lookup and one retry, then `tab send`. Never send
   an acknowledgement-only reply. A SendMessage is a tap on the shoulder, not a record: a claim others must see goes
   first to the system that owns it (a lease, the ticket or the PR). A seat that needs supersede or a readable state
   uses `tab send --supersede`.

## Amendment of ADR-0012 (the inbox carries no caller text)
A `message` item carries a caller's body. It is typed only when its sender workspace is its target workspace: the route
queues only then, the store refuses any other at enqueue, and the dispatcher checks again before the paste. Every other
kind keeps its fixed server line. The drive guard (B-1) is unchanged: the same caller could type the same text into the
same tab with `tab send` today.

## Amendment of ADR-0012 and ADR-0013 (a sender's text stays out of another workspace's turn)
For the SendMessage channel, between two lead tabs only, a sender's text enters another workspace's turn. The body does
not pass through the server. The authority is the owner's ruling of 20 Nov 2026. Notes stay the route between
workspaces for every other seat, and the server-to-seat path stays pull-only.

## The walls are policy plus audit for S1, not enforcement
Socket paths can be listed by any process of the same OS user, and Claude Code filters no sender by workspace. The
lookup guard, the audit line and the prompt rule are the wall. Real enforcement needs one OS user per workspace, or a
per-sender filter in Claude Code; that is outside this record. `crossSessionInbound` stays unset: `accept` would open
every seat to every process of the same user.

## Out of scope
- The server never writes to or connects to a socket (option 1 stays rejected).
- A seat's own hook posting to its own socket, until Claude Code publishes the message line format; a start-up
  self-test against a scratch session would then pin it.
- The leg between two hosts: a socket reaches its own host only (`address-other-host`); a remote tab is reached through
  the queue on its own server.
- Codex and Grok tabs: no queue, no address.

## Switches and rollback
- `tab-send.queue` (default on, admin token only, ADR-0027 R2): off, the route never queues (exit 5 as before) and the
  next inbox tick refuses each message not yet typed (queued, or held with no claim) `queue-off`. That refusal blanks
  its body, so after the tick no stored item holds a body. An unreadable store reads off at the route and on at the
  inbox tick.
- `tab-address` (default on, admin token only): off, every lookup is refused `address-disabled`; the queue is unaffected.
  `tab-address.lead-pair` (default on) turns off only the arm between workspaces. An unreadable config store refuses
  lookups and keeps the queue on.
- The switch stops new lookups, not a seat that already holds an address. To remove S1 fully: delete the prompt line,
  and set `crossSessionInbound: refuse` in hooks.json for new seats.
- **Rollback order:**
  1. Set `tab-send.queue` and `tab-address` off.
  2. Wait one inbox tick (2 s). That tick is the purge: it refuses every message not yet typed and blanks its body.
  3. Check each workspace with `inbox list -w WS --all`: no `message` item is `queued` or `held` without a claim, and
     every `message` item reads `bodyBytes: 0`. The previous release's `inbox list` serves raw items, so it must find
     no body.
  4. Deploy the previous release. It leaves held `message` items alone (`message` is not a recoverable kind). Do not
     run `inbox retry` on a `message` under the previous release: it would type only the header.

## Consequences
- A busy Claude tab gets a send mid-turn or at its turn end, with a state the sender can read, and no retry loop.
- Seats of one workspace, and two workspaces' leads, can message each other directly by SendMessage; purplemux knows
  each lookup but no body.
- Going live is a server restart on each host; the script reaches live seats at their next hook, the prompt line
  reaches seats launched after the restart.
- Real-session tests still open before go-live: RS-2 (an urgent nudge and a message in one turn), RS-3 (dialogs and
  compaction), RS-4 (a remote tab), RS-6 (a seat started before the restart registers), RS-7 (a prompting sender to a
  bypass receiver), RS-8 (restart or resume gives a new path; the old one answers `ENOENT`), RS-10 (lookup policy on a
  test instance), RS-11 (a remote tab is `address-other-host`), RS-12 (two test workspaces' orchestrators, a builder
  refused). Run RS-5 again when the fleet's Claude Code minor version changes.
