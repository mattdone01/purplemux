# ADR-0034: The constraint finder and the single owner board

## Status
Proposed (2026-11-03, epic `harness-flow-loop`, story 03: the finder, the board read and the CLI). The epic's
ADR-HFL-02. Story 12 extends this record with the board view inside Mission Control (sections, goal, layout).

## Context
About eight progress surfaces exist, and none says where work is stuck. The owner asked for status and ETAs 36 times
and said a page was out of date 25 times in 14 days (epic research 3.3). The work-item ledger (ADR-0033) now records
every wait with a reason from a closed vocabulary. What is missing is one computed answer: which reason holds the most
waiting time now, whether it is getting worse, who holds it and what clears it, with every measure that rests on a
missing input shown as unknown.

## Options considered
1. **Keep the surfaces; add a ledger panel to Mission Control.** A ninth surface.
2. **A static page rendered by a timer.** No answers, one more renderer to keep true.
3. **One purplemux view, the board, server-derived from a pure finder, inside Mission Control.**

## Decision
Option 3. This record holds the finder and the board read; story 12 adds the view.

1. **Finder.** `deriveConstraint(ledger, flow, spend, pool, now)` in `src/lib/constraint.ts`: no Node import, no I/O,
   no clock (a test reads its imports). Windows 6 h, 24 h and 7 d. Per reason and per stage: WIP, summed waiting hours,
   p50 and p90 of the waits that finished inside the window, throughput (waits finished inside it), and the trend
   against the window before; per window, items closed by type. Stages are the ledger's (`build-review`, `land`,
   `deploy`, `people`, `hosts`, and `unknown`): the epic's "build, review" is ADR-0033's one `build-review` stage.
   Waiting hours are finished waits clipped to the window plus open waits' elapsed time clipped to it, the read-time
   `unknown` of silent wait-life items included.
2. **The constraint** is the reason with the largest waiting hours in the last 24 h on critical items when any critical
   item waited, else on all items (`basis`). An item is critical when it, its parent, or the slice its own key names
   (`range:<lane>:<key12>` -> `slice:<lane>`) carries `attrs.critical` (v2 publishes `.v2/critical-path`): a fold member's
   parent is its fold, and its own lane may be critical (architect consult 03, A1). On the receipt-to-main parse
   (2026-10-26..11-03, all three sections) the finder names `not-armed` on both bases; the lane section alone names
   `land-queue/lock-busy`, a section cut kept as a regression case. **Known limit:** the rule goes one step. A `review`
   or `gate` whose parent is a range that is critical only through its own-key slice is not critical, so if producers
   make ranges the parents of reviews, the critical basis does not see those review waits. AC 2 states the rule this
   way; story 12 may extend it to the parent's own-key slice (or the full ancestry) when such links exist. Owner seat and clear input are weighted by open waiting hours under the reason; with nothing open, the
   owner is the holder that waited longest in the 24 h and the clear input is null. Ties go by name, ascending. Until
   story 13 routes reasons, the owner seat is a holder, not a routed seat.
3. **Trend.** `up` above +20% of the previous window, `down` below -20%, else `flat`; `new` when the previous window
   measured no wait; `unknown` when the ledger's history (its earliest item) starts after the previous window began.
   The constraint shows the 24 h trend.
4. **Anomalies** (architect ruling, story 03 consult). Each names its measured value, its unit and its threshold;
   `value: null` with a `reason` when an input is missing. Outcomes are read from the close `state` only, never from
   attrs: producers (stories 02, 09, 10) send that one encoding. Producer silence is keyed per (producer, item type),
   because its threshold is per type: keyed per producer, a long-lived lane `slice` (fewer than 20 closes in 7 days,
   so never judged) became the producer's longest-silent item once a breached review closed, kept the producer's
   raised flag from clearing, and muted every later silence of that producer (architect CONCERN 03-C1, probe in
   `tests/unit/lib/constraint-flags.test.ts`). Per type, an unjudgeable slice holds only its own subject. If story 02
   ever closes 20 or more slices in 7 days, the lane slices would breach permanently; `slice` then leaves the silence
   types (an amendment of ruling 6).

   | Id | Measure | Threshold |
   |---|---|---|
   | `re-gates` | gates opened in 24 h on a `tree12` a gate closed `pass` earlier with the same or a wider `attrs.mode` (full covers affected; no mode matches the tree alone; `reused` never counts); also the share of gates | 0 |
   | `rework-rate` | ranges closed in 24 h with a `rework` wait / ranges closed | 10%, flagged only from 10 closed (`n<10`) |
   | `context-per-call` | each open seat's latest `attrs.contextTokens` | `attrs.rotateAtTokens`, else 300,000 (ADR-HFL-04) |
   | `wakes-per-hour` | per tab: `tab_events` delivered in 6 h, class not `log`, one per `digest_id`, / 6 | 6/h |
   | `unknown-share` | `unknown` / all waiting hours on `range`, `deploy`, `owner-issue`, 24 h | 5% |
   | `producer-silence` | open `slice`, `gate`, `review`, `landing` items with no wait: now - last event, one row per (producer of the item's last event, item type), subject `<producer>/<type>`, naming that pair's longest-silent item: `<item> silent for <n> min (threshold <t> min)` | max(10 min, 2 x the type's 7-day p90 lifetime); unknown and never flagged under 20 closed of the type |
   | `cost-per-landed-item` | spend over the last 7 UTC days / ranges closed `landed` over the same days; a partial spend index notes its reason | none: reported, never flagged (story 04 owns the join) |

5. **Missing inputs** are `unknown`, never 0: `inputs.{ledger,flow,spend,pool}` each carry `state` (`ok`, `partial`,
   `stale`, `unknown`), `reason` and `at`. The ledger is `unknown` when it cannot be read (`ledger unreadable`) and when
   it holds no event for the workspace (`the ledger holds no event for this workspace`: no producer has spoken, which is
   not "nothing waited"). Then the answer has no constraint, no stuck item and no window, every anomaly reads `value:
   null` with that reason and its constant threshold, the line says the constraint is unknown, and the text form
   prints `stuck: unknown (<reason>)` and `anomalies: unknown (<reason>)`, never 0. A consumer (story 08's status push) reads
   `inputs.ledger.state`, never an empty list, to tell "not measured" from "nothing stuck". No flow record, a spend index
   that is `indexing` or `unavailable`, and no pool (none is published until ADR-HFL-09's scheduler) each read
   `unknown`; a flow older than 10 min reads `stale`; a ready spend index that reports an error reads `partial`.
6. **Tick.** One 60 s interval per process (`globalThis.__ptConstraintTick`, started beside the flag tick, stopped in
   `shutdownWs`) reads each workspace's inputs (`LedgerStore.finderSnapshot`: 14 days of waits, open items and items
   closed in 14 days, the producer of each open item's last event, the earliest item, deliveries per tab in 6 h) and
   caches the answer per workspace (`__ptConstraintCache`). The spend view (`by=workspace`, last 7 UTC days) and the
   pool are read once per tick, not once per workspace. A tick over 5 s logs its duration; the next is skipped while one
   runs (the ADR-0032 pattern); a workspace whose derive takes over 1 s logs its own duration. A read for a workspace the
   tick has not reached derives it at once, and concurrent reads share that one derive (`__ptConstraintInflight`).
7. **Board read.** `GET /api/cli/workspaces/{ws}/board` (read scope; `?mine=1` keeps the stuck items the calling tab
   holds, by name or id, and needs a tab token), `GET /api/mission-control/board?workspaceId=all|WS` (human session)
   and `purplemux board show -w WS [--json|--line|--mine]`. The board is the cached answer plus `workspaceId`, `ageMs`
   and `needsYou` (Mission Control's open items, id and title, oldest first; null when the store is unreadable).
   Every answer carries its age (`ageMs`) and `staleSince`: the answer's `generatedAt` when it is older than two ticks
   (120 s, `FINDER_STALE_MS`), else null. A consumer (stories 08 and 12) treats such an answer as stale, as the flag
   tick does: a hung tick leaves the cache in place with `inputs.ledger.state: ok`. `--line` and the text form then
   end the line with `stale since <time>` (AEDT/AEST).
   `onTrack.goal` is null until story 12's `board goal set`; with no goal `onTrack.state` is `at-risk`, so a consumer
   never reads "on track" against nothing. `--line` prints `goal · items left · constraint · trend`. The owner reads
   words, never tokens: `constraint.labels` and `stuck[].reasonLabel` come from one module
   (`src/lib/constraint-labels.ts`, the status push's wording), and `line` and the text form use only them; JSON
   consumers keep the tokens. `stuck` holds the 50 oldest waits, capped after the `--mine` holder filter; `stuckTotal`
   says how many matched, and the text form prints `50 of N`.
8. **Flags.** Each breached anomaly reaches the ADR-0032 tick as source `ledger` (`TAlertFlagSource`), rule the
   anomaly id, subject its seat, producer or `workspace`, and names the workspace's orchestrator until story 13 routes
   it. A workspace with no cached answer, whose ledger is `unknown`, or whose answer is older than two ticks (120 s) is
   an unread source (`ledger:<ws>`): its ledger flags neither raise nor clear, and the per-source baseline applies.
   Each anomaly subject is also its own source (`ledger:<ws>/<id>/<subject>`), failed while the anomaly cannot be
   judged (`judged: false`: value or threshold null, or a measure that never flags, such as rework under 10 closed),
   so an anomaly that turns unknown never clears a raised flag; a subject the finder stops reporting is forgotten.

## Consequences
- One read answers "where is it stuck, why, who holds it, what clears it" for every workspace, the same numbers for
  the web, the phone, the status push and the improvement seat.
- The tick costs one ledger snapshot per workspace a minute. On story 01's synthetic 92-day file (14-day read: 147,681
  intervals, 35,006 items) the snapshot takes 175-277 ms and the derive 173-266 ms, synchronous on the event loop; the
  14-day read is bounded by the `(workspace_id, end, start)` index, and the items read scans the workspace's items.
- Anomalies that rest on producers not yet live (seat context, tab events, gate verdicts) read `unknown` until stories
  02, 09 and 10 land; they never read as healthy.

## What proves it wrong
Replay 2026-10-27..11-03 at 60 s ticks with one gate producer killed mid-run: producer silence flags more than one
normally-closing item a day, or misses the killed gate within its threshold, or re-gates breach on every tick of the
week (then the threshold moves to story 20's 1.3 gates per landing). For the board as a whole: status and ETA asks do
not fall below 1 a week within 14 days of the board, or the owner names a stuck item the board did not show.
