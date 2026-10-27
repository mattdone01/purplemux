# ADR-0026: Flow read model — a published pipeline snapshot, server history and derived bottleneck flags

## Status
Proposed (2026-10-26, epic `purplemux-flow`, stories 01 and 02). Amended by ADR-0032 (the flags also raise alerts).

## Context
Mission Control shows each tab's state (ADR-0023). It does not show the pipeline that a workspace's orchestrator runs:
the landing queue, the landing lock, gate slots, reviews that wait, lanes against budget. On 2026-10-26 the treasury-v2
workspace held its landing lock 92% of 6 h with 16 queued landings, the oldest 67 h old. The owner saw this only on an
out-of-harness page (`~/.local/share/v2-flow/flow.py`). Only the producer can read those facts (they live in the
producer's own files), so the harness must accept them as a published snapshot, the way it accepts a burndown
(`src/lib/burndown.ts`, `src/lib/burndown-store.ts`). A board script runs from a timer and keeps no state, so the history
must be kept by the server, the way standups are (`src/lib/standup-store.ts`).

## Options considered
1. **Producer-sent history (the burndown shape).** No server derivation; but every producer must keep state, and the lock
   busy share differs per producer.
2. **Flow inside the Mission Control SQLite snapshot.** One poll; but it couples a producer feed to the attention-item
   store and its schema version.
3. **A per-workspace JSON store with a server-appended history row and pure server-side derivation.** One validator, one
   store, one derivation for the web panel, the phone, the CLI and the flag alerts.

## Decision
Option 3.

1. **Snapshot.** `IFlowSnapshot` (`src/types/flow.ts`, new): `schemaVersion: 1`, `generatedAt` (ms), `source` (1..64),
   `queues` (≤ 20: `name` 1..64 unique, `capacity` integer 1..10000 or null, `items` ≤ 500: `id` 1..128 unique in its
   queue, `label` ≤ 120 or null, `since` ms, `state` `queued|active|held`, `pinned` boolean, `holder` ≤ 128 or null),
   `locks` (≤ 20: `name` unique, `heldBy` ≤ 128 or null for a free lock, `since` ms or null, null when free), `meters`
   (≤ 50: `name` unique, `value` finite, `unit` ≤ 16, `limit` finite or null, `windowMinutes` 1..10080 or null),
   `flags` (≤ 20: `text` 1..200, `severity` `info|warn|block`). Unknown keys are refused, so a typo never drops data. No producer string holds a control character (`\p{Cc}`) or a bidi control (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069), because `flow show` prints them raw; an identifier (`source`, a queue, lock or meter name, an item `id`, `holder`, `heldBy`, `unit`) also holds no other format character (`\p{Cf}`), so two look-alike names cannot both pass the uniqueness check; `label` and flag `text` keep the other format characters (ZWJ, ZWNJ, tag characters, soft hyphen). A refusal echoes such a character as `\u{…}`. `heldBy` is null or non-blank. No
   time is more than 5 min after the receive time. The serialized snapshot is at most 1 MiB.
2. **Validation** is one pure, hand-written function, `parseFlowSnapshot(raw, receivedAt)` in `src/lib/flow.ts` (new),
   with no Node import, so the UI may import it. Each refusal names the field, what it saw and what it expected (the
   `parseBurndownSnapshot` style).
3. **History.** At each publish the server derives one row from the snapshot: `{at: receivedAt, queues: {name: length},
   oldest: {name: oldest item since | null}, locks: {name: held}, meters: {name: value}}`. The record keeps at most
   2,000 rows and at most 4 MiB serialized; the oldest rows go first. A producer never sends history.
4. **Store.** `workspaces/{wsId}/flow.json` (path from `resolveLayoutDir`), `IFlowRecord {workspaceId, receivedAt,
   snapshot, history}`, 0600, tmp + rename, one lock per workspace on `globalThis.__ptFlowLocks`, a parsed-record cache
   keyed by mtime and size on `globalThis.__ptFlowReadCache`. A file that does not parse or re-validate is never read as
   empty: a reader gets `FlowStoreError` (`flow-unreadable`), and the next publish first renames it to
   `flow.json.corrupt-<receivedAt>`, then writes a fresh record and answers `historyReset: true`.
5. **Derivation** (story 02) is pure, in `src/lib/flow-flags.ts` (new): `deriveFlowFlags(record, thresholds, now)`.
   Thresholds come from fleet config (ADR-0019), read the `readThresholds` way: `flow.window-minutes` (default 360,
   10..10080), `flow.lock-busy-percent` (80, 1..100), `flow.queue-length` (10, 1..10000), `flow.oldest-minutes` (240,
   1..10080). An unset or invalid value reads as its default, and the reason is logged. Rules:
   - `stale`: `now − receivedAt > 10 min`. A stale record raises only this flag; the other rules do not run on old data.
   - `lock-busy`: the lock's busy share over the window is at least the percent. The share is time-weighted: each history
     row's lock state holds from its `at` to the next row's `at` (the newest row holds until `now`); an interval longer
     than 10 min is unknown time and counts on neither side. When the known time is less than half the window, the share
     is `null`, the lock is listed in `insufficientHistory`, and no flag is raised.
   - `queue-long`: a queue holds at least `flow.queue-length` items.
   - `queue-old`: a queue's oldest item is older than `flow.oldest-minutes`.
   - `queue-full` (severity `block`): a queue with a `capacity` holds at least that many items.
   - `meter-over`: a meter's `value` is above its `limit`.
   Flags sort `block` first, then `warn`, then by rule and subject. `IFlowDerived {flags, lockBusyShare: {name: number |
   null}, lockKnownMinutes: {name: number}, insufficientHistory: string[], windowMinutes, thresholds}`.
6. **Routes.**
   - `POST /api/cli/workspaces/{ws}/flow`: an own-workspace token only (`authorizeWorkspace`, so a peer, a grant or the
     admin token gets `forbidden`). 2 MB body limit. 200 `{ok, workspaceId, receivedAt, generatedAt, historyRows,
     historyReset, bytes}`; 400 `flow-invalid`; 413 `flow-too-large`; 404 `not-found` for an unknown workspace; 500 `flow-write-failed` when the store cannot write (the previous record stays).
   - `GET /api/cli/workspaces/{ws}/flow[?history=all|window|none]`: read scope (`accessDecision`). 200 `{flow:
     IFlowRecord | null, stale: boolean | null, derived?: IFlowDerived}`; 500 `flow-unreadable`. Default `history=all`.
   - `GET /api/mission-control/flow`: human session (`requireMissionHuman`). 200 `{workspaces: [{workspaceId,
     workspaceName, receivedAt, generatedAt, source, stale, producerFlagCount, derivedFlagCount}], errors:
     [{workspaceId, error}]}`. One unreadable record goes to `errors`; it does not blank the list.
   - `GET /api/mission-control/flow?workspaceId=WS[&history=window|none|all]`: 200 `{workspaceId, flow, stale,
     derived?}`; 503 `storage-unavailable` for an unreadable record. Default `history=window` (the rows of the derived
     window only). A CLI token on either human route gets 401.
   - Every route sets `Cache-Control: no-store`. `derived` and the list row's `derivedFlagCount` arrive with story 02; a client without them ignores them.
7. **CLI.** `purplemux flow publish -w WS --json @FILE` prints `ok <receivedAt> <historyRows>`; `purplemux flow show -w WS
   [--json] [--history all|window|none]` prints queues, locks with busy share, meters, producer and derived flags, and
   `stale` when stale. `flow show` with `flow: null` prints `no flow published` and exits 7 (`flow-not-found`,
   client-side, as `config get` does for an unset key). New codes in `CODE_EXIT` and the ADR-0016 table:
   `flow-invalid` 2, `flow-too-large` 2, `flow-unreadable` 1, `flow-not-found` 7.
8. **The panel** (story 02) mounts on the default Mission Control view between "Needs you" and the portfolio board. It
   polls the human route every 60 s while visible, renders `derived` and producer flags first, then queues, locks and
   meters. A stale record shows "stale — last published <age> ago" above the data. It sends nothing to a tab.

## Consequences
- Every orchestrator can publish its own board; treasury-v2's `flow.py` gains one `purplemux flow publish` call (owner
  local, outside any repository).
- The derived flags are one server answer, read by the web panel, the phone (story 13), `flow show` and the flag tick
  (ADR-0032). The phone never derives a flag.
- A deploy keeps the store (JSON on disk); the first publish after it continues the history.
- The 4 MiB record bound and the per-mtime read cache keep the human detail read under 200 ms (NFR-7); `history=window`
  keeps the phone payload small.
- Non-goal: the harness never reads a producer's files; a producer that stops publishing shows as `stale`, never as an
  empty pipeline.
