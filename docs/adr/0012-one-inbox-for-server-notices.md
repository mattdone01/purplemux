# ADR-0012: one inbox for server-originated notices

_Epic stories: 09 (store, dispatcher, list/retry); users 10 (notes), 12 (Mission Control), 13 (deploy), 14 (watches), 26 (API-error resume) — see `_output/purplemux-portfolio-coordination/stories/`._

## Status
Accepted (2026-09-26, epic `purplemux-portfolio-coordination`, story 09).

## Context
Notes, watch firings, deploy announcements and Mission Control deliveries must reach agents in tabs the originator may not drive. Mission Control's reconcile bootstrap typed multi-line prompts into seven other workspaces' orchestrators and polled one for about 44 minutes. ADR-0008 already says an unattended dispatcher needs a composer.

## Options
1. **Per-feature delivery** (each feature calls `deliverPrompt`). Repeats the Mission Control mistake four times.
2. **Queue into the watchdog's `AutomatedPromptDispatcher`.** No readiness gate; types mid-turn; same workspace only by construction.
3. **One inbox:** one entry point, a fixed per-kind template rendered on the server, delivery only to an agent at its prompt with an empty composer, bounded refusals, visible state.

## Decision
Option 3. Watchdog nudges stay on their current path (research Q6).

- **One entry point:** `enqueueNotice({ kind, targetWorkspaceId, targetTabId, dedupeKey, fields })` (`src/lib/inbox-store.ts`). A `dedupeKey` still queued returns the existing item. There is no HTTP route that enqueues.
- **No caller text in the line** (`src/lib/inbox-templates.ts`). `deliverPrompt` submits what it types as a user turn, so the line is `[purplemux <kind> <id>] <server fields> — <pull command>`, where every field matches a grammar: server-made ids (`n-`, `w-`, `d-`, `r-`, Mission Control item ids), workspace and tab ids (never names — names are caller-set), epoch-ms times and whole-number counts, an epic slug (`[a-z0-9-]{1,64}`, passed only by a sender that holds `epic:<slug>`), and — for a watch, which goes only to the tab that registered it — that tab's own target (`owner/repo#n`, `owner/repo@ref`, a lease name). A field that fails its grammar is refused, never cleaned. Subjects, reasons and titles are pulled (`note show`, `deploy status`, `mission answers`).
- **Readiness** (`src/lib/composer-readiness.ts`, extracted from Mission Control): a live session; no native permission prompt; `cliState` idle or ready-for-review, or WAITING (`busy` and `StatusManager.isWaitingAtPrompt`, ADR-0018 ruling A′ — architect ruling A′-inbox, 2026-09-26); no option list on the captured pane; an empty composer. It runs inside `withAgentDispatchLock`, after the model-policy check. Mission Control keeps its idle/ready-only sequence until story 12 moves it onto the inbox.
- **Dispatcher** (`src/lib/inbox-dispatcher.ts`): a 2 s tick started beside the Mission Control runtime and stopped in `shutdownWs`. Per target tab, one item at a time, oldest first. A refusal backs off 10 s → 30 s → 2 min → 5 min; a tab whose state refused and that is now at its prompt (including a stop just classified WAITING) is tried on the next tick. After 30 refusals, or 24 h, the item is `held` with its last refusal. A paste that throws is `held transport-uncertain`; a line still in the composer after the paste is `held stranded-in-composer`; neither is retried blind.
- **Death and retention:** `tab-closed` drops the tab's `queued` and `held` items (`target-tab-closed`); the owning feature re-routes. `delivered`, `dropped` and `held` items are pruned 7 days after their last transition.
- **Visibility:** `GET /api/cli/inbox?workspaceId=` (read scope) / `purplemux inbox list -w WS [--all]`; `purplemux inbox retry ID` (the target workspace's token or admin) re-queues a held item once.
- **Authority stays with the features.** The inbox never decides who may notify whom: notes (any resolved caller may send; the recipient decides whether to read), watches (only the watch's own tab), deploy (admin or the `deploy:purplemux` holder), Mission Control (its existing rules).

## Why this does not weaken the drive guard (B-1)
`canDriveWorkspace` refuses caller-supplied user-turn input into another workspace. The inbox line carries none: its content is fixed by the server, so the only thing a sender controls is that a fixed, pull-only notice appears. Review round 1 (H4) rejected an earlier "sanitised 120-character subject" as a cross-workspace channel.

## Consequences
One place to bound, observe and test delivery; Mission Control's retry loop stops typing once story 12 lands. A recipient that stays unready gets `held` and visible, never 45 blind attempts. `~/.purplemux/inbox.json` is one Node process's file under one promise mutex, written tmp + rename, mode 0600; a file that is not `{ items: [...] }` is refused, not read as empty.
