# Design check: typed, validated worker-to-worker events (vel-D6)

Status: design check before code. ADR: [ADR-0043](../adr/0043-typed-worker-events.md) records the decision.

## Problem

A cross-workspace note is admitted only from the verified, designated source coordinator
(ADR-0013, `NotesService.admissionFor`). A worker that has a routine hand-off (`review-ready`,
`landed`, `blocked-on`) therefore reports to its orchestrator. The orchestrator reads the report,
checks the evidence by hand, and sends the note again: about 2 paid turns for each hand-off. The
manual checks found real defects (a missing gate, a receipt saved under the wrong name, a missing
review folder). The checks must move into the server. They must not disappear.

## 1. The approach

1. A coordinator declares a worker tab's **scope** once per dispatch:
   `event scope set --tab TAB --epic SLUG [--story KEY] [--depends-on A,B] [--attempt N]`.
   The served epic must be an `epic:<slug>` lease held by a live tab of the same workspace (lease
   data, ADR-0011). The scope dies with the tab (tab ids are never reused).
2. A worker sends `event send --type T --to-epic SLUG --json PAYLOAD`. The target must be the
   scope's epic or one of its `dependsOn` epics, else `event-out-of-scope`.
3. The payload has a fixed, strict schema per type. Every type carries `repo`, `branch`, `head`,
   `base` and `attempt`. Unknown fields are refused.
4. Pluggable validators run over an injected `IEvidenceReader` (files, git, one command). All
   validators run, and a refusal lists every failure as `measured / expected`.
5. A validated event becomes a note with the new admission mode `event`. The notes service routes
   it like a coordinator note: to the live epic holder in the same workspace, else to the holder
   workspace's live orchestrator. Inbox line, ack, reminder and expiry are the notes' own.
6. Coordinator visibility: `landed` and `blocked-on` are status changes, so the source coordinator
   gets one short status note (type, target, key; no payload). `review-ready` is a step result
   for the task's owner, so the source coordinator gets no line. It sees the event with
   `note list`, because the sender workspace may list and show its notes.
7. No terminal or tab control is granted. Nothing the worker wrote is typed into any tab.

## 2. The state machine

```
            send (HTTP POST /api/cli/worker-events)
                         |
                       [sent]  ---- caller not a verified tab, no scope, target not in scope,
                         |          attempt != scope attempt, schema invalid --------> [refused]
                    validators
                         |  any validator fails ------------------------------------> [refused]
                    [validated]
                         |  duplicate dedupe key (same attempt, range, key) --------> [refused]
                         |  no live recipient (epic unowned, coordinator not live) -> [refused]
                         v
                    [delivered]  (note `delivered`; its inbox line is queued, then typed)
                         |
                  note ack by the routed recipient (ADR-0013 rules)
                         v
                      [acked]
```

- `sent`, `validated` and `refused` are states of one request. A refusal answers the HTTP request
  with a code and a reason and writes one `typed-event-refused` line to the coordination audit
  log. Nothing is stored in the notes file.
- `delivered` and `acked` are the states of the delivery note. The note carries the event record
  (`note.event`: type, payload, scope, check ids, dedupe key). A delivered note that later loses
  its recipient re-routes by the notes rules (`queued`, `undeliverable`, `expired`).
- An event is refused at send when it has no live recipient (input 4 of the coordinator brief,
  trueforge `NoResponderError`). The worker learns at once. An event never sits unseen.

## 3. Alternatives, with evidence from the code

| Option | Evidence | Verdict |
|---|---|---|
| A. Extend notes: a new admission mode plus an `event` field on the note | `NotesService.recipientOf` already routes `coordinator` and `owner` admissions across workspaces; `preflight`, `ack`, reminders, expiry and the inbox line (883 lines, ADR-0013) are reused unchanged. `INote` already carries optional producer fields (`externalKey`). | **Chosen.** |
| B. A separate event store with its own delivery | Delivery needs the same pieces as notes: routing at delivery time, re-route on a closed tab, the paste preflight inside the inbox dispatch lock, the ack rules, the 30/60 min clocks. ADR-0013 lists four review rounds of defects in exactly that code. A copy would repeat those defects. | Rejected. |
| C. The work-item ledger (ADR-0033) | `ledger.sqlite` is an append-only metrics feed. It is scoped per workspace by a ledger token (`ledger-token.ts`) and has no delivery path and no recipient. ADR-0026 rules that the harness never acts on a producer's files. | Rejected: a measure, not a message. |

The scope declaration also had alternatives:

- The worker self-declares a `story:<key>` lease with its dependencies in the lease note. Rejected:
  the worker would grant itself its own scope.
- Derive the dependencies from `status.yaml`. Rejected: `_output/` is producer scratch, and the
  harness never reads a producer's files (ADR-0026).
- A coordinator-written scope record (chosen). It costs one coordinator command per dispatch,
  not one turn per hand-off, and the coordinator already runs `tab create` at dispatch.

## 4. The three hardest adversarial inputs

1. **Evidence paths that escape, or that never end.** A payload names `/dev/zero`, a FIFO, a
   symlink to `~/.purplemux/notes.json`, or a 10 GB log. Defence: every path is absolute; the
   reader resolves `realpath` and refuses a path outside the sender workspace's `directories`
   (plus `PMUX_EVENT_EVIDENCE_ROOTS`); it reads only regular files under a byte cap (gate log
   32 MiB, others 1 MiB). The `repo` obeys the same roots. A refusal names the path, never the
   contents.
2. **A key or command that is not what it seems.** The patch-id command runs with `execFile` (no
   shell), `cwd` = the confined repo, a minimal environment (`PATH`, `HOME`, `LANG`; no
   `PMUX_TOKEN`), a 60 s timeout and a 1 MiB output cap. `head`, `base` and `key` must match
   `^[0-9a-f]{40}$|^[0-9a-f]{64}$` before they reach an argument list, so `--upload-pack=…` or
   `HEAD~1` never reaches git. `branch` must match a ref grammar with no `..`, no leading `-`.
3. **A stale or replayed result.** (a) A gate log with two runs, the first one green for the head
   tree: only the last run counts (from the last `START=`, the last `GIT_TREE_END=`, exactly as
   `gate-commit-check.sh` reads it). (b) A head that is no longer the branch tip: `range` refuses
   it (`refs/heads/<branch>` must resolve to `head`, and `base` must be an ancestor of `head`).
   (c) A restarted worker on an old attempt: the payload `attempt` must equal the scope's
   `attempt`, else `event-stale`. (d) The same event twice: a dedupe key over
   (type, target, workspace, story, attempt, head, base, key) is refused as `event-stale`, naming
   the note it already delivered.

Not defended: a worker that forges its own evidence files. The worker owns those files. The
checks catch mistakes (the three found by hand), not forgery. Remote tabs (ADR-0022) keep their
evidence on another host, so the server cannot read it: their events are refused as missing
evidence, and they keep the coordinator path.

## 5. Acceptance criteria

- AC1: `event send` from a verified worker tab with a declared scope, to its served epic or to a
  declared dependency, with valid evidence, creates one note with `admission.mode = "event"`,
  routed to the target's recipient by the ADR-0013 rules. No coordinator re-types it.
- AC2: each payload schema is strict: a missing field, a wrong form, or an unknown field is
  `event-invalid` (exit 2), and the message names every defect.
- AC3: `review-ready` runs four validators, each refusing with `measured` beside `expected`:
  `gate-tree` (last-run `GIT_TREE_END=` equals `git rev-parse <head>^{tree}`), `patch-id` (the
  configured command over `base..head` prints `key`; default `tools/patch-id.sh <base> <head>`),
  `review-folder` (the folder holds `range.txt`, `diff.patch`, `status.txt`, `patch-id.txt`,
  `record.md`), `receipt` (named `<key>.md`; holds no `verdict: BLOCK`, which belongs at
  `<key>.block.md`). Every type also runs `range` (head is the branch tip; base is its ancestor).
- AC4: a validator failure is `event-refused` (exit 3) and lists every failed check.
- AC5: a target outside the scope, a tab with no scope, an unverified caller, or an admin token is
  refused (`event-out-of-scope` or `forbidden`, exit 3). Only the workspace's verified designated
  coordinator sets or clears a scope.
- AC6: the receiving recipient gets the notes' fixed inbox line and acks with `note ack`.
  `landed` and `blocked-on` also send one status note to the source coordinator, except when the
  coordinator is the delivery recipient. `review-ready` sends the coordinator no line.
- AC7: an old attempt or a duplicate is `event-stale` (exit 3); an event with no live recipient is
  `event-no-recipient` (exit 5) and stores nothing.
- AC8: every validator has a hermetic test over a fake reader, and every state above has a test.
  Each test is proven by the mutation recorded below.
- AC9: `pnpm lint && pnpm test && pnpm build` pass.

## Mutation record

Each row: the change made to the code, the test that failed, then the change reverted.

| # | Mutation | Failing test |
|---|---|---|
| (filled in after the tests exist) | | |
