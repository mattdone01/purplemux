# Design check: vel-D5 — a durable checkpoint before a context rotation

Status: design check, written before code (story `vel-d5-durable-rotation`, base `05d56b83`).
Amends ADR-0036 (context lifecycle). Inputs: the independent review pinned to `05d56b83`, and the coordinator's
design inputs (harness restore from plain files; a fsynced journal with a restore notice; recovery that reads stored
state and freezes a step stuck mid-flight; no summary as the recovery mechanism).

## 1. The approach

1. The handoff check passes. The server collects the mechanical facts with one git probe on the tab's own host:
   worktree, branch, head, base ref and merge base, dirty count.
2. The server builds a checkpoint: those facts, plus the agent's own fields read from the handoff sections, which the
   checker already validated. The resume command is the intended next action, `## Open questions` the outstanding
   decision ids, `## Do not` the failed approaches, the standing-rule sources the evidence references,
   `## Decisions in the last 24 h` the rationale, `## In flight` the task rows, and the whole text is kept too.
3. The server writes the checkpoint to a new `rotation_checkpoints` table in `ledger.sqlite`. That file is the existing
   ledger (WAL, `synchronous = FULL`). Then it reads the row back and compares its SHA-256 digest. Only a matching
   read-back allows `restart --clear`. If the write fails, the rotation stops: the seat stays `handoff-ready`, the seat
   item carries `checkpointRefused`, the log has an error line, and the fleet view counts the refusal.
4. The key is `seat:<ws>:<tab-name>#<attempt>`. The task id is the seat item key. It stays the same across restarts,
   sessions and provider accounts. The attempt number comes from the table, not from the best-effort seat item.
   No session id or account is part of the key.
5. Every checkpoint row moves forward only: `written → cleared → delivering → delivered`, or ends as `abandoned`,
   `undelivered` or `delivery-unknown`. Each step is a conditional `UPDATE … WHERE status IN (…)`, so a step that
   runs again changes nothing.
6. Resume: the fresh session is idle. The server probes git again, compares the result with the checkpoint, and puts
   the handoff file and `<handoff>.checkpoint.json` on the tab's host. That host is ssh for a remote tab. Then it
   types the first message with a RESTORE NOTICE. A match says what was verified. A mismatch names each difference
   and asks for explicit reconciliation before the resume command. Both say what was NOT restored.
7. A remote seat (`--host` with `--handoff`) is allowed now. The handoff file is read over ssh, and the checkpoint
   stays on the control host. A host that does not answer is a wait. It is not a failed check, because the seat
   cannot repair a network fault.
8. Telemetry (the seat item and the counters) stays best effort. Only the checkpoint row gates the clear.

## 2. The rotation state machine, with the durable step

```
watching ──(threshold | PostCompact, canRotate)──► rotate-requested  ── ROTATE typed; rotationDueAt kept
rotate-requested ──(turn ends HANDOFF-READY)──► handoff-ready
handoff-ready ──(canRotate, checkHandoff)──┬─ fail ──► rotate-requested (message) │ rotation-alarm (2nd)
                                           └─ pass ──► CHECKPOINT
CHECKPOINT  [new]  facts = git probe (tab host) ── host silent ──► handoff-ready, refused "host did not answer"
                   put(row status=written) ; get(row) ; digest equal?
                     ├─ no / throws ──► handoff-ready, checkpointRefused, log.error, retry; the deadline bounds it
                     └─ yes ──► rotating (seat item, best effort)  ──► restart --clear
rotating   restart ok  ──► mark written→cleared ; rotations += 1 ; wait-to-rotate = restartedAt − rotationDueAt
           restart busy ──► handoff-ready (retry)       restart refused ──► mark written→abandoned ; failed check
rotating   fresh session idle ──► RESUME
RESUME [new]  probe git again ; compare with the checkpoint ; restore the handoff and the checkpoint json on the tab host
              mark cleared→delivering  (the freeze point)
              type first message (+ RESTORE NOTICE, + MISMATCH lines) ── typed ──► mark delivering→delivered ; watching
                                                                      └─ not typed ──► mark delivering→cleared (retry)
              TTL 10 min ──► mark →undelivered ; handoff-undelivered flag ; watching
server start  read the latest checkpoint row (stored state, not the seat item):
              cleared, or written with a bound session ≠ sessionBefore  ──► rotating, first message rebuilt from the row
              delivering ──► FROZEN: mark →delivery-unknown, flag handoff-undelivered, never typed again
              delivered | abandoned | undelivered | written + same session ──► the ADR-0036 seat-item resume as before
```

## 3. Alternatives, with evidence from the code

| Option | Evidence | Verdict |
|---|---|---|
| A. Make the existing seat-item `state` event durable: write `rotating`, then read the item back. | `ContextLifecycle.write` (`context-lifecycle.ts:255`) is one best-effort helper for every event: readings, compactions and phases. Ledger attrs are scalars only (`TLedgerAttrValue = string \| number \| boolean \| null`, `types/ledger.ts:13`), so lists such as decision ids would be JSON in a string. A seat item has one projection per tab, so a later `clear` reading overwrites the attrs of the rotation, and the history of attempts is lost. | Rejected. It mixes telemetry and the gate in one write. |
| B. A table inside `ledger.sqlite`, the same pattern as `tab_events`, `tab_turns` and `landings` (`ledger-store.ts:283-296`). It holds one row per attempt and is read back before the clear. | The same file and handle, already `synchronous = FULL`, already in WAL, already backed up and kept. No second database. | **Chosen.** |
| C. Also commit the checkpoint into the worker's git worktree (coordinator input 1). | A server commit on an agent branch races with the agent's own commits and goes into story landings (`story_land.py` judges tree ids). A remote worktree is out of this host's reach while ssh is down, and that is exactly when recovery needs the commit. | Partly taken. The checkpoint JSON is written as a plain file beside the handoff on the tab's host: best effort before the clear, again at resume. It is never committed. The git facts in the checkpoint make recovery from git alone possible. |
| D. Remote seat: `rsync` the handoff to the control host on HANDOFF-READY. | `runSsh` / `runSshBuffer` (`remote-host.ts:190-233`) already read remote files and run remote scripts. D63 already judges a remote tab's background jobs on its own host. | Rejected. One `cat` over ssh at check time is enough. |
| E. Threshold: lower the default to 100,000 so that it matches ADR-0036's Consequences. | `DEFAULT_ROTATE_AT_TOKENS = 300_000` (`constraint.ts:48`), and ADR-0036 §1 states "default 300,000". Only the Consequences line says "50-100k". A fresh Claude seat starts with the instruction files and the tool schemas already loaded. The workspace instruction budget alone is up to 150,000 characters (`test_instruction_budget.py`), about 35-40k tokens (an inference). | Rejected. **The ADR is updated to the real default of 300,000:** at 50-100k a seat rotates after very little work. A seat can still lower its own value with `--rotate-at`. |

## 4. The three hardest adversarial inputs

1. **The server crashes between the checkpoint write and the clear, or inside the clear.** The row is `written`.
   On start the server reads the row. If the bound session is the one before the restart, no clear ran. The ADR-0036
   resume (`handoff-ready`, check again) runs, and the next pass writes the same attempt again. That write is
   idempotent: the same digest is a no-op, and a changed file replaces a row that is still `written`. If the bound
   session changed, the clear ran. The seat is `rotating`, and the first message comes from the row even when the seat
   item write was lost. A crash after the paste and before `delivered` leaves `delivering`. That row is frozen as
   `delivery-unknown` and flagged, and it is never typed a second time.
2. **The remote host is unreachable at resume.** The git probe or the file restore fails with an ssh failure.
   Nothing is typed, because typing over that same ssh would fail too. The row stays `cleared` on the control host,
   and the next idle or tick tries again. After 10 minutes the row is `undelivered` and the board flags
   `handoff-undelivered`. The checkpoint is never lost: it is on the control host, and the fleet view names its id.
   An ssh failure when the server reads the handoff file before the clear is a wait, not a failed check, so no alarm
   counts a network fault against the seat.
3. **The worktree moved on after the checkpoint.** A background job committed, someone rebased the branch, the
   worktree was deleted, or the tab now runs in another directory. The second probe gets the checkpoint head as an
   argument and runs `git merge-base --is-ancestor`. The notice tells "moved on (an ancestor)" apart from "rewritten
   (not in its history)", and also reports a changed branch, a changed worktree, a missing directory and a changed
   dirty count. A mismatch never blocks the session. The session gets the differences and must record its
   reconciliation in the handoff before it runs the resume command. The seat item gets `checkpointMismatch`.

## 5. Acceptance criteria

1. AC1: No `restart --clear` runs unless a checkpoint row for this attempt was written and read back with an equal
   digest. A write that throws, or a read-back that is missing or differs, stops the rotation. It sets
   `checkpointRefused`, logs an error, counts `checkpointRefusals`, and is tried again inside the rotation deadline.
   A ledger telemetry write that fails still never stops a rotation.
2. AC2: The checkpoint holds the task id, the attempt, the worktree, base and head, the branch, the intended next
   action, the failed approaches, the outstanding decision ids, the evidence references, the rationale and the full
   handoff. Its key has no session id or provider account. Tools fill the facts. The agent fills only its handoff
   sections.
3. AC3: `tab create --host <alias> --handoff <path>` is accepted. A remote seat's file is read on its host. The
   checkpoint is stored on the control host and written back to the remote host at resume. An ssh failure is a wait
   and never a failed check.
4. AC4: The first message after a rotation carries a RESTORE NOTICE with the checkpoint id. It names what the
   checkpoint verified and what it does not restore. On a mismatch of worktree, branch, head or dirty count it lists
   each difference and asks for reconciliation before the resume command.
5. AC5: ADR-0036 and the API guide state 300,000 as the default, and the code is unchanged.
6. AC6: The fleet view (`IFleetView.rotation`, read by `/api/mission-control/coordination`) reports the active agent
   workers, the covered workers (seats whose rotation is on) and the coverage ratio. It reports successful rotations,
   refused handoffs, refused checkpoints and timed-out rotations. It reports the total and the mean wait-to-rotate
   (rotation due to clear), and the seats that wait now.
7. AC7: Restart tests at four workflow points: after implementation, during a long background job, after review, and
   after a merge before the deploy acknowledgement. Each point is crossed with each crash point: before the
   checkpoint, after the write, after the clear, during delivery, after delivery. In each case the right task
   resumes, the decision ids are kept, the clear runs at most once, and the first message is typed at most once.
8. AC8: A mutation proves each new branch, recorded below. `pnpm lint`, `pnpm test` and `pnpm build` pass.

## Out of scope (measured first, as the review asks)

Ordinary tabs without a handoff path still do not rotate. AC6 measures coverage first. Whether to give every worker a
default handoff path is a product decision that this measurement informs. Codex and Grok still cannot run remotely
(ADR-0022).

## Mutation record

Filled in after implementation: each row names a mutation of a new branch and the test that fails on it.
