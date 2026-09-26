# ADR-0015: Harness watches — server-evaluated, tab-owned, one-shot, generic state only

## Status
Accepted (2026-09-26), epic `purplemux-portfolio-coordination`, story 14.

## Context
On 2026-09-25 orchestrators went blind: ddh's `& disown` pollers finished red about 2.5 h before anyone read them, and pft-1385 was never told that its blocker (ui#517) had merged. A shell poller belongs to no tab, outlives the turn that started it, and reports to nobody. A caller refused a lease had no way to wait except a loop.

## Options
1. Keep shell pollers and add discipline (`run_in_background`, `tab bg add`). That has been the rule since 09-23; 09-25 shows the rule alone does not hold, and a poller for another epic's PR has no natural owner.
2. GitHub webhooks into purplemux. They need an internet-reachable endpoint; the server is tailnet-only.
3. Server-side polling with the server's own `gh`, owned by a tab, reported once through the inbox, removed with the tab.

## Decision
Option 3, for generic GitHub state and for leases.
- Kinds and conditions: `pr OWNER/REPO#N` until `merged`, `closed` (merged or not, reported as which), `head-moved`, `checks-settled` (at least one check run or commit status, none running or pending; green/red counted); `ref OWNER/REPO@REF` until `moved`; `lease NAME` until `free` (no holder, or a holder that is not live).
- A baseline (head or ref sha) is read at creation. A PR or ref `gh` cannot find is `watch-invalid`; `gh` unreachable is `gh-unavailable`.
- Store: one host file, `~/.purplemux/watches.json` (0600, tmp + rename, a malformed file refused). One file makes the host-wide cap one atomic count; the story sketched per-workspace files.
- Evaluation: its own 15 s timer with a one-pass-at-a-time guard, not a slot in `StatusManager.poll` — that poll awaits each step, and 60 GitHub reads with 20 s timeouts there would stall tab status. A GitHub watch is read when its interval (default 120 s, 60-3600) is due; a lease watch on every pass and at once on each lease release event. Reads run outside the store lock; results apply by id, so a watch cleared meanwhile is not reported.
- Reporting: ONE inbox line (ADR-0012 template; target, shas, counts and tokens are grammar-checked server values) to the owner tab, then the watch is deleted. Three consecutive failures send one `failing` notice with a server-classified token (`http-404`, `http-403`, `timeout`, `auth`, `gh-missing`, `other`); a success resets it; the raw `gh` text is only in `watch list`. Expiry (default 24 h, max 7 d) sends one notice.
- Lifetime: `tab-closed` removes the tab's watches; the boot pass drops watches of tabs confirmed gone (an unreadable workspace keeps its own).
- Caps: 60 GitHub watches per host (`watch-cap`, exit 3; 60 × 2 calls / 120 s stays inside the 5,000/h budget shared with every session's `gh`); 30 watches per tab.
- Authority: the calling tab owns its watch; `list` is the caller's workspace (admin: any); `clear` is the owner tab or admin.
- NomuPay-specific state (the `ai-review-state` marker, label arming) stays in the skills' `pr-poll.sh`; purplemux carries no NomuPay knowledge.

## Consequences
- An agent waits for a merge, a head move, CI or a lease with one command and hears once, in its own composer, even after its turn ended.
- A server restart loses no watch (the JSON store) but delays evaluation by the restart time.
- ETags are not used yet: `gh api` gives no conditional request without `-i` parsing; the caps bound the budget instead.
