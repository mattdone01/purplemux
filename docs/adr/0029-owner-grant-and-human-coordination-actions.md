# ADR-0029: Owner grant and human coordination actions

## Status
Proposed (2026-10-26, epic `purplemux-flow`, stories 05 and 06). Amends ADR-0013 (a fourth note admission, `owner`) and
ADR-0014 (a second capability, `owner`). ADR-0021 holds unchanged: no grant authorizes a foreign mutation.

## Context
On 2026-10-26 the owner's own Claude session (a tab in the owner's workspace) could not read another workspace ("Workspace
read access is out of scope", `src/lib/cli-utils.ts:82`) or send it a note ("cross-workspace notes require the verified,
currently designated source coordinator", `src/lib/notes-service.ts:242`). It fell back to `tmux send-keys`, which skips
every delivery guarantee of ADR-0012. What exists:
- `accessDecision` admits the admin token, the own workspace, `allowedPeers`, a legacy drive grant (reads only since
  ADR-0021) for named workspaces, and the human-selected Scrum Master.
- Note admissions are `local`, `coordinator` (the verified orchestrator of its own workspace) and `human` (a browser
  session, bound to one target workspace; only the portfolio action uses it, `sendHumanPortfolio`).
- `inbox retry` and `lease break` are CLI-only; deploy announcements reach agents only.
The owner's session is not an orchestrator and not the selected Scrum Master. The phone holds no CLI token (phone
ADR-0003), so every human action it needs must have a cookie route.

## Options considered
1. **Make the owner's tab its workspace's orchestrator.** Notes work at once; reads do not, and the tab then gets
   watchdog nudges meant for an orchestrator.
2. **Use the admin token in the owner's session.** It reads everything already; but every agent can read that token, so
   its use is no evidence of the owner, and it cannot send a note as anyone.
3. **A drive grant with `workspaces: ['*']`.** One store; but `drive` means "named workspaces", and widening it would
   silently widen every holder.
4. **A new grant capability `owner`, made only through the human gate, plus cookie routes for the human actions.**

## Decision
Option 4.

1. **Capability and store.** `IGrant.capability: 'drive' | 'owner'`. An `owner` grant has `workspaces: ['*']`; the
   service refuses `'*'` on a `drive` grant and any other list on an `owner` grant (`grant-invalid`). Owner grants live
   in their own file, `~/.purplemux/owner-grants.json` (same record shape, same lock and tmp + rename, 0600), read by the
   same store module with the file as a parameter. Reason: the live release's parser (`isGrant`,
   `src/lib/grant-store.ts:150`) accepts only `capability: 'drive'` and refuses the WHOLE `grants.json` when one record
   differs, so a rollback would honour no drive grant for up to 7 days (ended records are kept that long). An older
   release never reads the new file. `GET /api/grants` and `GET /api/cli/grants` list both files; an unreadable owner
   file refuses owner grants only (`grant-store-unreadable`), never drive grants.
2. **Creation.** Only `POST /api/grants` (cookie, this server's Origin, the purplemux password; ADR-0014), body
   `{capability: 'owner', granteeWorkspaceId, granteeTabId, reason, expiresInHours, password}` (`workspaces` is not
   sent; default 24 h, maximum 168 h). The grantee must hold a `launch` identity, else 409 `grant-tab-unverified`. While
   one owner grant is active, a second answers 409 `grant-owner-active`. No CLI token reaches the route.
3. **Reads.** `accessDecision` gains one branch after the peer check: a verified tab that is the grantee of an active
   `owner` grant reads every workspace, including one created after the grant. Mutation predicates
   (`authorizeWorkspaceMutation`, `canDriveWorkspace`) do not change, so `tab send`, `tab steer`, `tab close`,
   `tab create`, `tab restart`, `mission events`, `flow publish` and `browser eval` into another workspace stay
   `forbidden` (exit 3), and the denial keeps naming notes as the supported path.
4. **Notes from the owner's tab.** `INoteAdmission.mode` gains `'owner'` with `grantId`. `admissionFor` tries
   `coordinator`, then `local`, then `owner` (an active owner grant whose grantee is the verified caller tab). Routing
   treats `owner` as `coordinator`: the note goes to the target workspace's enabled orchestrator (an epic target resolves
   to its holder's workspace at delivery, ADR-0013). The admission is stored on the note at send time; a later revoke
   does not unsend it. The inbox notice gains the server-made boolean `fromOwner`; it carries no caller text (ADR-0012).
   `note show` and `note list` print `from owner (<ws>/<tab>)`.
5. **Audit.** Grant create, revoke and expiry as ADR-0014; one `owner-note` line per note sent under the grant; at most one
   `owner-read` line per (grant, workspace) per hour (`globalThis.__ptOwnerReadAudit`), not one per call.
6. **Human note.** `POST /api/mission-control/notes` (`requireMissionHumanMutation`), body `{toWorkspace?, toEpic?,
   subject, body}` with exactly one target. It uses the **existing** `human` admission through
   `NotesService.sendHuman(actor, targetWorkspaceId, {subject, body})`, a generalization of `sendHumanPortfolio`.
   `toEpic` resolves at send time to the workspace of the live holder of `epic:<slug>`; with no holder, 400
   `note-target-missing`. ADR-0013 bounds hold (subject ≤ 120, body ≤ 16 KiB, 400 `note-too-large`, 409 `note-cap`).
   200 `{note: INoteView}`. A human is never a note recipient, so no human acknowledgement exists.
7. **Human inbox retry.** `POST /api/mission-control/inbox/{id}/retry` runs `retryInState` as `inbox retry` does, for
   any workspace's item. It refuses with 409 `inbox-not-retryable` and the hold reason when the reason is
   `stranded-in-composer` (text may already sit in the composer, so a retry can type it twice) or `target-not-agent` (it
   can never succeed). One exported predicate, `humanRetryRefusal(item)` in `src/lib/inbox-store.ts`, owns that list, and
   a test pins it against every hold reason that `src/lib/inbox-dispatcher.ts` can write.
8. **Human lease break.** `POST /api/mission-control/leases/break`, body `{name, reason}` (reason 1..500, else 400). It
   runs the same state transition as the admin `lease break` (`breakLease`), with the breaker recorded as
   `{human: <session subject>}` in the `released` effect and the audit line.
9. **Deploy announcements.** `GET /api/mission-control/coordination` gains `deploys?: {ok: true, items: [{id, reason,
   createdAt, restartAt, phase: 'pending'|'past', by, recipients: {total, delivered, queued, held, dropped}}]} |
   {ok: false, error}`: the announcements of the last 24 h, newest first. An older client ignores the section.
10. **Auth for 6-8.** Cookie plus this server's Origin; a CLI token, no cookie or another Origin gets 401/403. None of
    the three routes sends input to a tab.

## Consequences
- The owner's session reads and notifies through the harness; the `tmux send-keys` fallback has no reason to exist.
- The owner grant is visible: `grant list` shows `capability: owner, workspaces: *`, and the web grant badge marks the tab.
- The web coordination panel and the phone (story 14) share the three cookie routes.
- Threat model unchanged from ADR-0014: the password is the evidence of the human; a same-uid process that writes the
  grant file is outside the model.
