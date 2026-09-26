# ADR-0013: notes route to the epic owner; the body is pulled, never typed

_Epic story: 10 — see `_output/purplemux-portfolio-coordination/stories/10-notes-with-ack.md`._

## Status
Accepted (2026-09-26, epic `purplemux-portfolio-coordination`, story 10).

## Context
At least six cross-epic notes written on 2026-09-25 were never read: pft-1162 → ddh, pft-1376 → pft-1386 (the DLQ filter), reply-2 I1/H12 → pft-1386 before its merge, B5 → DCM, B5 → PBA, pft-1087 → pft-1376. A file in `portfolio-*/` has no delivery path, and the drive guard (correctly) refuses cross-workspace input. On 2026-09-26 the portfolio moved every epic into one workspace, so a workspace is not a stable address for an epic either.

## Options
1. **Type the body through the inbox.** Breaks the inbox's no-caller-text rule (ADR-0012) and floods a composer.
2. **Route by workspace only.** An epic moves between workspaces.
3. **A file drop with a watcher.** Exactly the 2026-09-25 failure: nothing reads it.
4. **A note store; route to the owner at delivery time; type only a fixed notice.**

## Decision
Option 4.
- `note send --to-epic <slug>` resolves the recipient **at delivery time** as the live holder of `epic:<slug>` (ADR-0011); `--to-workspace <ws>` resolves to that workspace's enabled orchestrator. With no live recipient the note is `undeliverable` — listed, never dropped. The lease store's acquire hook routes an epic's waiting notes the moment the epic is claimed; a 15 s tick covers everything else (orchestration turned on, a re-route, the clock).
- The recipient tab receives only the inbox's fixed line (ADR-0012), whose event is a server enum: `delivered` `[purplemux note n-…] from <ws>/<tab> at <time> — purplemux note show n-…, then purplemux note ack n-…`; `reminder` (to the recipient); `unacked` and `expired` (to the sender). The subject and the body are never typed. An epic slug is not typed either: any tab may hold `epic:<words>` (ADR-0012 amendment). `note list` and `note show` display them.
- `--from-epic` is accepted only from the holder of that epic lease; the note then records the epic as its sender's.
- If the inbox drops the notice (its tab closed before delivery), the note returns to `queued` and routes again, to whoever owns the epic by then. A missing inbox item re-routes only if the line never reached a composer: the inbox prunes delivered items after 7 days, and that is not a drop.
- Two clocks, one shot each (review round 1). The recipient's reminder starts when the line reached its composer (the inbox item's `deliveredAt`): a busy recipient is not reminded of a line it has not seen, and a closed recipient tab is not reminded at all. The sender's notice starts at routing (`routedAt`): a recipient that never goes idle is exactly the case the sender must hear about. One reminder at 30 min; one notice to the sender's tab (if live) at 60 min; no more. Each completed step is saved even if a later step of the same pass fails.
- `note list --to-me` is the tab the note was routed to, not the workspace: the portfolio's epics share one workspace. A token with no tab reads its workspace.
- Epic slugs use the lease grammar (`EPIC_SLUG`, ADR-0011), so any holdable epic is addressable.
- A sender holds at most 50 open notes; the 51st is refused with `note-cap` (exit 3). One tick runs at a time; a tick asked for meanwhile runs once afterwards. Each tick reads the lease, tab and inbox facts once.
- Authorisation: `note send` — any resolved caller; `note show` — the recipient workspace, the sender workspace, or admin (else exit 3); `note ack` — the recipient workspace only, and only a delivered note (else exit 3). An unknown id exits 7.
- Bounds and retention (B-2): subject ≤ 120 characters with control and format characters removed; body ≤ 16 KiB UTF-8 (exit 2); acked notes are pruned 14 days after the ack; a note unacked or undeliverable 14 days after creation becomes `expired` (one notice to a live sender) and is pruned 14 days later.
- Store: `~/.purplemux/notes.json`, one process-wide lock. A malformed file is refused, not read as empty (the next write would erase it). Lock order is notes → inbox, never the reverse.

## Consequences
- A cross-epic note reaches whoever owns the epic now, and the sender can see it was delivered, acked, or is still waiting.
- The drive guard is untouched: a note never uses the drive path, and nothing a sender writes is typed into another workspace's tab.
- Agents are told at turn start to run `note list --open --to-me` (both agent prompts and the API guide); story 18 carries the command-body side.
