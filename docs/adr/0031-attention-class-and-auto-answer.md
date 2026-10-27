# ADR-0031: Attention class, stated default, and the bookkeeping auto-answer

## Status
Proposed (2026-10-26, epic `purplemux-flow`, stories 08 and 09). Amends `docs/mission-control-contract.md`.

## Context
The owner answered 155 attention items in 7 days; 40 were budget raises. The board cannot show which items are money or
irreversible and which are bookkeeping. The owner wants a rule that answers bookkeeping items with their stated default
and records a note ("default and a note", 2026-10-26); money, irreversible and scope items are never answered by a rule.
What exists: `attention_items.question_json` holds the whole question and is read by a plain spread (`itemFromRow`,
`src/lib/mission-control-store.ts:297`), so extra keys survive an older binary; `answers.actor` is free text; the
side-table precedent `mission_item_openers` (ADR-0023 §6) adds a table without a `SCHEMA_VERSION` change. A schema bump
is a one-way door: a release rolled back onto a newer file refuses it, and all of Mission Control fails.

## Options considered
1. **New columns and `SCHEMA_VERSION = 5`.** Queryable; a rollback refuses the database.
2. **Class and default inside `question_json`; the auto-answer record in an unversioned side table.** No version change;
   the class is still queryable with `json_extract`.
3. **Class guessed by the server from text.** Rejected by the owner's brief: only the producer sets it.

## Decision
Option 2.

1. **Fields.** `attention.opened` and `attention.updated` accept optional `class: 'money' | 'irreversible' | 'scope' |
   'bookkeeping'` and optional `defaultOptionId`, which must name one of the item's `options[].id`. An `action` item has
   no options, so a `defaultOptionId` on it is refused. An unknown class or a default that names no option refuses the
   whole batch with 400 (the atomic-batch rule), naming the field. The fields live in `question_json`; `SCHEMA_VERSION`
   stays 4. `IMissionAttentionItem` gains `class: TAttentionClass | null` and `defaultOptionId: string | null`, null when
   absent. An `attention.updated` may change both, under the existing revision rule.
2. **Board.** "Needs you" groups items Money, Irreversible, Scope, Bookkeeping, Unclassified, in that order. A card shows
   its class and "Default: <option label>". The default is never pre-selected.
3. **Answers per class.** `IMissionSnapshot` gains `answersByClass?: [{day, class: TAttentionClass | 'unclassified', by:
   'human' | 'rule', count}]` for the last 7 UTC days, from `answers` joined to `attention_items` in the snapshot read.
4. **The rule.** Fleet config `attention.auto-answer.bookkeeping-minutes`: an integer 1..10080. Unset, or any invalid
   value, is **off** (an invalid value is logged). The rule version is that key's fleet-config `version`. The key is
   written by the admin token only (`ADMIN_ONLY_KEYS`, ADR-0027 §1): under the ADR-0019 writer rule any orchestrator
   could otherwise switch on a rule that answers other workspaces' items without the owner.
5. **Eligibility.** All must hold: state `open`; `humanReview.humanNeed` is not `none`; `class` is `bookkeeping`;
   `defaultOptionId` is set and names an option; `kind` is not `action`; the item's last revision is at least N minutes old
   (a re-asked question waits N minutes again). Money, irreversible, scope and unclassified items never qualify.
6. **The answer.** A 60 s tick (one per process, `globalThis.__ptAutoAnswerTick`, started beside the Mission Control
   runtime, stopped in `shutdownWs`) calls `MissionControlStore.submitSystemAnswer` (new). It records an answer with
   `optionIds: [defaultOptionId]`, actor `system:auto-answer`, `submissionId: auto:<itemId>:<revision>` (unique, so a
   restart never answers twice) and `expectedRevision` = the revision read (so a human answer or a cancel that came first
   wins, and a race leaves exactly one answer). The answer text is the note:
   `Auto-answered under fleet config attention.auto-answer.bookkeeping-minutes=<N> (version <v>) at <ISO time>: applied the stated default "<option label>".`
   The item becomes `answered`; delivery to the agent is the normal Mission Control path. The rule never resolves or
   cancels an item.
7. **The record.** `mission_auto_answers(answer_id PRIMARY KEY, item_id, workspace_id, rule, rule_version,
   applied_option_id, at, note)`, created with `CREATE TABLE IF NOT EXISTS` and written in the answer's transaction.
   The snapshot item gains `autoAnswer: {rule, ruleVersion, appliedOptionId, at, note} | null`; the snapshot gains
   `autoAnswered?: [{itemId, workspaceId, runId, title, class, appliedOptionId, appliedOptionLabel, at, note,
   itemState}]` (the last 7 days, newest first, at most 100). One `attention-auto-answer` audit line (item, workspace,
   rule, version, option, age) per answer.
8. **The system actor is server-only.** Producers post events and cannot post answers. The human answer route refuses a
   session subject that starts with `system:`. Only the tick calls `submitSystemAnswer`.
9. **Producers.** The api-guide § Mission Control documents both fields with one example and the rule "a producer that
   cannot name the class omits it". The scrum-master brief tells teams to set them (story 18, engineering).

## Consequences
- A release rolled back onto a database written by this code still opens it; the rollback check is part of `/dod`
  (open a copy with the `882190ab` release in a scratch HOME and serve `GET /api/mission-control`).
- The rule is off until the owner sets the key; nothing changes on deploy.
- Every rule answer is visible on the web board and the phone with its note, for 7 days, and in the audit log.
- Non-goal: a server guess of class; a rule for any class but bookkeeping; a rule that chooses another option.
