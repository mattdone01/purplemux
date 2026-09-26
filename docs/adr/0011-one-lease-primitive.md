# ADR-0011: one lease primitive for every held resource

_Epic stories: 03 (store, policy, sweeper), 27 (API and CLI) — see `_output/purplemux-portfolio-coordination/stories/`._

## Status
Accepted (2026-09-26, epic `purplemux-portfolio-coordination`, story 03).

## Context
On 2026-09-25 six orchestrators merged into the same repositories within 35 minutes, two sessions each believed they owned one merge chain, and ADR and migration numbers collided. The merge race (L1), two owners (L4) and number reservations (L2) are one failure: a thing two sessions both believed they held, with no record that refuses the second.

## Options
1. **Three bespoke stores** (merge queue, ownership registry, number ledger). Three APIs, three sweepers, three list views.
2. **File locks (`flock`) in the skills scripts.** No server change, but a flock dies with a process, not a tab, is invisible to a list, and carries no TTL or epic.
3. **One lease store in purplemux with a kind policy table.** One API, one sweeper, one list; per-kind rules for TTL and tab binding.
4. **A Mission Control SQLite table.** Transactions for free, but it collides with the briefing branch's schema and couples coordination to Mission Control.

## Decision
Option 3. The cases differ only in lifetime, and lifetime is a per-kind policy (`src/lib/lease-policy.ts`):

| Kind | Resource form | Default TTL | Max TTL | Binding | Authority |
|---|---|---|---|---|---|
| `merge` | `<owner>/<repo>` | 45 m | 3 h | tab | any resolved caller |
| `dev-deploy` | `<owner>/<repo>` | 45 m | 3 h | tab | any resolved caller |
| `dev-write` | `<env>` | 60 m | 8 h | tab | any resolved caller (advisory) |
| `deploy` | `<service>` | 30 m | 2 h | tab | admin token or the workspace's enabled orchestrator tab |
| `epic` | `<slug>` | none | 7 d | tab | any resolved caller |
| `num` | `<owner>/<repo>:<adr\|migration>:<nnnn>` | 14 d | 30 d | survives the tab; requires an epic | any resolved caller |
| any other | free-form | 30 m | 24 h | tab | any resolved caller |

- `~/.purplemux/leases.json` `{ leases: ILease[] }`, one promise mutex on `globalThis.__ptLeaseLock`, tmp + rename, mode 0600. Every transition is a pure function over the state (`src/lib/lease-store.ts`), so the rules unit-test without a file. A file that is not `{ leases: [...] }` is refused, never read as empty: an empty read would hand every held resource to the next caller. The boot sweep catches that refusal and logs it, so a corrupt file never stops the server; every lease operation keeps failing closed until the file is repaired or moved aside.
- Names are lower-cased and must match `^[a-z][a-z0-9-]{1,31}:[a-z0-9._/@#:+-]{1,200}$`. Re-acquire by the holder renews (`outcome: 'renewed'`). Another tab of the same workspace is another holder.
- The holder comes from `resolveCaller` (ADR-0010): `{ workspaceId, tabId, tabName, verified, admin }`. A holder is a tab or the admin token; a workspace token that names no tab is refused with `caller-unresolved`, because it could never renew or release what it took. An admin-token holder is `admin`, never "human", and it must hold a TTL: nothing else ends its lease. A re-acquire without a TTL keeps the lease's own, as `renew` does; the `verified` flag records the latest proof.
- Every transaction first prunes the leases past their expiry (reason `expired`), so an expired lease never refuses a caller or answers a check between sweeps. Audit lines and hooks are emitted inside the lock, in the order of the mutations.
- `break` needs the admin token and a reason. It is cooperative, not a security boundary: every agent process can read the admin token (C-312 class). `release-epic` releases all of an epic's survives-tab claims for the `epic:<slug>` holder or admin, and only its own workspace's claims for a tab of a workspace that holds some; with no claims it answers an empty list, never a refusal. A closing owner therefore runs `release-epic <slug>` while it still holds `epic:<slug>`, then releases `epic:<slug>`; in the other order, other workspaces' claims stay held until their TTL.
- Death (`src/lib/lease-sweeper.ts`): a tab-bound lease is released on `tab-closed` (`holder-tab-closed`); a sweep beside the liveness tick in `StatusManager.poll()` releases expired leases (`expired`), tab-bound leases whose holder tab is in no layout on disk (`holder-tab-gone`), and those whose holder is an agent tab seen `inactive` for 10 minutes (`holder-agent-gone`). Tab existence comes from the layouts on disk, never the StatusManager map; a workspace whose layout exists but cannot be read or parsed makes its tabs unknown, never gone, and a lease renewed after the tab facts were taken waits for the next sweep; the inactive clock is in memory, so after a restart the 10 minutes start again. The boot sweep runs after `getStatusManager().init()`.
- Every transition appends one JSON line to `~/.purplemux/audit/coordination.jsonl` (rotated at 10 MB, three generations kept). `onLeaseAcquired` / `onLeaseReleased` let notes (ADR-0013) and lease watches (ADR-0015) follow the store.
- Waiting is not a lease feature: a refused caller ends its turn or registers a lease watch.

## Consequences
`lease list` becomes the portfolio's live register of merges, owners and number claims. A stale holder is visible by `holderState` and age; the worst case for a forgotten merge lease is 45 minutes, for a crashed owner 10 minutes after the sweeper first sees its agent inactive. The store is one Node process's JSON file (the custom server and the Next API graph share `globalThis`), so the mutex serialises every writer and no cross-process lock is needed.

Source of truth for the epic: `_output/purplemux-portfolio-coordination/architecture.md` (nomupay workspace).
