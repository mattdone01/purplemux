# ADR-0044: Typed turn ends: the stop payload and `purplemux done`

## Status
Accepted (2026-11-10, epic `delivery-flow-fix`, story F6, which folds in F10 steps 1 and 2). One Opus 5.5 xhigh
design consult, APPROVE-WITH-CHANGES. Amends ADR-0018 (the turn end is a row when one exists) and ADR-0043 (a scope
carries a seat).

## Context
A worker's verdict was a regex over the last 600 characters of its transcript: one end line was refused 406 times in
36.5 h, and a slow transcript flush read as no end line. The Stop hook dropped its own payload, which carries the
message. F10 (typed control channel) plans a typed turn end in two steps before any delivery change; this record
takes those two steps.

## Decision
1. **The stop payload (F10 step 1).** The Claude Stop hook posts its own JSON to `/api/status/hook?kind=stop&session=`.
   The stop's `last_assistant_message` (its last 600 characters) is the tail when its `session_id` is the tab's bound
   session. The transcript is still read for the background counts, and a different end line there is logged. Fleet
   key `hook.stop-payload=off` restores the transcript tail.
2. **The row (F10 step 2).** `purplemux done --verdict DONE|BLOCKED|NEEDS-DECISION|READY-TO-MERGE|CHECKPOINTED
   [--reason] [--story] [--head] [--gate-log]` writes one `turn_ends` row (`ledger.sqlite`, additive). Its key is
   (agent session, turn id). The turn id is a per-session counter in `session_turns`, bumped by each live
   prompt-submit that no tool sent. It is never the in-memory event sequence, which a restore resets. A second `done`
   in the turn replaces the first; exactly one stop consumes a row.
3. **Checks at write time.** These are the ADR-0043 validators `range`, `gate-verdict` and `gate-tree`, and only
   these. The repo is the git top level of the caller's cwd, and `head` defaults to its branch tip. A builder seat's
   DONE and READY-TO-MERGE need `--gate-log`. A reviewer or consult seat may give one, and it is checked when given.
   `--reason` is cleaned to one line of at most 500 characters; a reason with a marker word is refused. BLOCKED and
   NEEDS-DECISION need a reason. A remote tab cannot write a row: the server cannot read its evidence.
4. **The seat.** `event scope set … --seat builder|reviewer|consult`. With no seat declared, a scope that names a
   story is a builder.
5. **At the stop.** The server decides within 1 s; past that, the stop goes through on the classifier. Options:
   - **Row:** a row that the payload tail does not contradict is the verdict. Its line is synthesized as
     `<MARKER>: <reason> (story K, head <12>, gate <verdict>)` and feeds the nudge, `reportOn`, the coordinator window
     and the NEEDS-DECISION item. The classifier runs beside it, and a disagreement is logged (7 days of shadow,
     then F10 step 5 deletes it).
   - **WAITING:** a stop whose tail has no marker, while the tab has a live registered job, an armed watch or an open
     provider task, is WAITING and needs no row. An unknown count holds nothing.
   - **Held:** a scoped worker's turn end with no row is held with `{"decision":"block","reason":"Run purplemux
     done …"}`, at most twice per turn (counted in the ledger). The third stop goes through, writes an `UNREPORTED`
     row with reason `cap`, and takes the classifier's verdict.
   - **Contradicted row:** a row of DONE, READY-TO-MERGE or CHECKPOINTED under a BLOCKED or NEEDS-DECISION tail is a
     hold reason in the same budget. At the cap, the escalating verdict (the tail's) applies.
   - **Never held:** a StopFailure, a replay, a remote tab, an evaluator tab, a non-Claude tab, a tab in an open
     rotation, a coordinator and an unscoped tab. A scoped turn end among them with no row gets an `UNREPORTED`
     `not-blockable:<why>` row; a coordinator and an unscoped tab keep the classifier alone.
6. **A hold is pending until confirmed** (amended by the CONFIRM review of 2026-11-10). Confirmation is positive,
   never inferred from the screen. A hold is confirmed by any hook event of the session after it: a tool call, a
   prompt, a notification, a stop, or a `done` row. A working tab shows an empty composer too, so the pane is never
   read. The one sign that a hold never arrived is Claude's own `idle_prompt` notification with no event since the
   hold: the session waits for input. The held stop is then applied at once. It uses the turn's row if the worker wrote
   one, else an `UNREPORTED` `block-undelivered` row. A hold with no such sign stays pending, and the tab's existing
   stall signals cover it.
   - An `UNREPORTED` write never replaces a row. When the turn has one, that row is kept and marked used.
   - A replayed stop is judged against its own turn: the latest turn that started at or before it fired
     (`session_turn_starts`). It is never judged against the session's current turn.
   - The Stop and StopFailure hooks both get a 5 s timeout (tmux 1 s, the POST 3 s).
7. **Kill switches**, admin token only: `turn-end.source` (`row`, or `classifier` to hold nothing and read rows not
   at all) and `hook.stop-payload` (`on` or `off`).

## Consequences
- The script prints only a well-formed one-line block object. Any other answer, or none, lets the stop through: the
  guard fails open.
- A worker that ignores the hold costs at most two forced continuations per turn, then the stop goes through.
- Rows are reported by source (`done`, `unreported` with its reason), and holds per day are a worker cost.
- F10 step 3 (messages) and step 5 (deleting the classifier) build on these rows; neither is part of this record.
