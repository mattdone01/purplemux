# Design check: vel-D4, one shared budget per host

Story `vel-d4-shared-budget`. Base commit `05d56b83`. Amends ADR-0039 §2-§5.

## 1. Approach

1. Each known host has one budget: CPU threads and memory. A reserved control-plane share comes off the top. The rest
   is the worker budget.
2. Every pool kind (`gate`, `build`, `mutation`, `browser`, `test-service`, `tab`) has a CPU and memory envelope. A
   held lease reserves its envelope from the worker budget of its host until release, TTL or holder close. Agent tabs
   in the layouts reserve the tab envelope. The separate `floor(threads/8)` caps go.
3. Two independent checks admit work. The ledger check compares envelopes with the configured budget and never reads
   measured use. The measured check compares the live read with the envelope, and subtracts only the reservations the
   read cannot show yet (the 60 s lag). No figure is counted twice.
4. Classes: `product` (application repair, candidate validation; the default) and `harness` (harness and optional
   jobs). A harness job holds at most `pool.harness-share-pct` (default 25 %) of a worker budget. Waiting harness
   tickets under that share keep their arrival order with product tickets, so they never starve.
5. `control-plane` is a tab class: it runs here, draws on the reserve, and is never queued or refused.
6. A queueable request that fits no host gets a ticket (lease kind `pool-queue`) with its position and the measured
   and expected figures. The waiter re-asks with the ticket. The ticket becomes a slot lease in one lease transaction.
7. `tab create --host auto` always queues. It never falls back to this host on a capacity answer.
8. The budget comes from fleet config (`pool.budget.<host>.*`, `pool.envelope.<kind>.*`, `pool.harness-share-pct`).

## 2. Admission state machine

```
requested --(fits host H; no earlier ticket may run on H)----------------> admitted --(release | TTL | holder closed)--> released
    |  \
    |   `--(no fit; queue asked; not too-large)--> queued --(re-ask: fits; next for H)--> admitted
    |                                                |  ^
    |                                                |  `--(re-ask: no fit; TTL renewed at half life)
    |                                                `--(no re-ask in 120 s | holder closed | pool release)--> gone
    `--(invalid | too-large | no fit and no queue asked)--> refused
```

| From | Event | To | Written in the lease lock |
|---|---|---|---|
| requested | fits host H; no ticket ahead may run on H | admitted | slot lease `pool:<H>/<kind>-<n>`, note `pool mem= threads= class=` |
| requested | no fit, `queue: true`, not too-large | queued | ticket lease `pool-queue:<kind>-<n>`, TTL 120 s, the request in the note |
| requested | no fit, no `queue` | refused | nothing (`409 pool-full` with the refusal and the figures) |
| requested | the envelope exceeds every allowed host | refused | nothing (`409 pool-full`, `too-large`) |
| queued | re-ask, fits and next for H | admitted | the ticket is released and the slot lease taken in one transaction |
| queued | re-ask, no fit | queued | the ticket TTL is renewed only when less than half of it is left |
| queued | no re-ask in 120 s, holder closed, release | (gone) | ticket pruned or swept |
| admitted | release, TTL, holder closed | released | the slot lease leaves the ledger |
| control-plane tab | any | admitted (here) | a tab lease in the reserve ledger; over the reserve is stated, not refused |

A tab start is a short admission: the tab lease (TTL 300 s) holds the envelope from placement until the tab exists in
the layout. The route releases it after the create, so the layout count takes over.

Order of the queue. A product ticket has rank 0. A harness ticket has rank 0 while its envelope fits under the harness
share on at least one allowed host, else rank 1. Inside a rank, the order is arrival (`acquiredAt`, then the name).
A request (new or ticket) may take host H only when no ticket ahead of it may run on H. There is no backfill: a small
request never takes capacity that accumulates for a larger ticket ahead of it.

## 3. Alternatives, with evidence from the code

| Option | Evidence | Verdict |
|---|---|---|
| A. Keep per-kind caps, make each smaller | `slotCapOf()` (`src/lib/pool.ts:57-63`) computes each kind's cap from the same threads with no shared term. ai-server: 8 gate + 8 build slots = 128 modelled threads on 64. Any per-kind split still sums past the host when a kind is added (mutation, browser, test-service), and it says nothing about memory. | Rejected |
| B. Measured-only reservation (openharness `superTabs/reservations.ts`: reserve against measured free memory, drop the reservation 5 min after start) | This is the model the pool has now: `unseen()` (`src/lib/pool.ts:72-73`) counts a lease only within `LOAD_LAG_MS` (60 s) of the read. The review found that it gives no headroom for a later peak: a treasury-api gate fallback reaches 30 GiB minutes after start (ADR-0039 §6, 2026-10-14). openharness drops the reservation because it compares reservations with measured free memory: holding it counted each job twice and refused a start with 7.85 GiB free. | Rejected as the only check. Kept as the measured guard, with the double count removed (below). |
| C. Server-side deferred create (store the POST, replay it when capacity frees) | The create route (`src/pages/api/cli/tabs/index.ts`, POST, about 200 lines) runs the role, WIP-cap, launch-command, Codex managed-launch and status-registration steps against the request. A replay from a timer runs in the custom-server module graph (CLAUDE.md §18), not the API-route graph that owns those steps. | Rejected. The waiter holds a ticket and re-asks; the create runs on the normal path. |
| D. Chosen: ledger against the budget + measured guard + ticket queue in the lease store | `acquireChosenLease` already runs placement inside the lease lock (`src/lib/lease-store.ts:483`). Tickets as leases reuse the lock, the TTL prune, the holder-tab sweeper and the audit. | Chosen |

How D avoids the double count that openharness hit: the ledger check is `sum(envelopes) + new ≤ worker budget`. It
compares reservations with a fixed capacity, never with measured free memory. The measured check is
`MemAvailable − (memory of leases taken within 60 s of the read) − new ≥ 4 GiB`. Older leases are not subtracted
there, because the read already shows them. Each check counts each job once.

CPU. Readings are momentary, so the hard CPU limit is the ledger: envelope threads against worker threads. That is a
CPU slot count per host, in threads. The measured CPU check refuses only a sustained overload:
`min(load1, load5) + unseen threads + envelope threads > max-load` (default: the host's threads).

Enforcement. purplemux does not launch gates or builds, so it cannot put them in a cgroup. Every admission answers
with its `envelope {threads, memGb}`. A launcher that supports limits passes them on, for example
`systemd-run --user --scope -p CPUQuota=<threads×100>% -p MemoryMax=<memGb>G` or `docker run --cpus <threads> --memory
<memGb>g`. Docker sets no limit by default.

Escalate once. A ticket writes one audit line (`lease-acquire`) and one log warning when it queues. A re-ask renews
the ticket only when less than half of its TTL is left, and the CLI prints a queued line only when the position or
the reason changes. A waiter pauses; it does not spin.

## 4. The three hardest adversarial inputs

1. **A job that exceeds its envelope at its peak.** A gate declares `--mem 8` and reaches 30 GiB. The ledger still holds
   only its envelope, so the ledger alone would admit more work. The measured check sees the overrun in `MemAvailable`
   at the next read (30 s) and refuses new work while free memory minus the new envelope is under 4 GiB. The running
   job is not stopped: that needs the launcher to enforce the envelope (§3). The refusal names both figures:
   `measured 6.0 GiB free, needs 12.0 GiB (8 GiB envelope + 4 GiB floor)`.
2. **A host that goes unreachable while it holds reservations.** The host reads `unknown`. Its leases stay in the
   store and in its ledger (the view shows them), and nothing new is placed there. A ticket that may run only there
   (a local-only tab when this host is unknown) waits. Other tickets go elsewhere. The leases end by release, TTL or
   holder close. When the host reads again, its ledger already holds them, so it is not over-filled.
3. **A burst of tab starts at once.** Twenty `tab create --host auto` calls arrive together. The layouts do not show any
   of the new tabs yet. Each call places and takes its tab lease inside the lease lock, so call k sees the k−1 tab
   leases before it. The calls fill the budgets in order. The rest get tickets with positions 1..m and the measured
   and expected figures. When a tab lease is released or a tab closes, the next re-ask of the head ticket is admitted.

Other inputs and their answers:

- The orchestrator tab of a workspace is in the control-plane ledger, not the worker ledger.
- A stored budget value that is not valid (hand-edited) keeps the default, as `pool.slots.*` does.
- A ticket for a request larger than every allowed host is refused at once (`too-large`): a ticket that can never
  be admitted would block its hosts for every request behind it.
- A pool that does not answer `tab create --host auto` in 2 s still creates the tab here (ADR-0039 §4), and logs it.
  That answer is not about capacity. A tab lease that the late answer took expires in 300 s.
- A `--cwd` missing on the chosen remote host releases that host's tab lease and asks the pool again for this host
  only. This host is admitted or queued on its own budget. It is never a free fallback.

## 5. Acceptance criteria

1. Two kinds can no longer each reserve a host's full CPU. At the measured sizes (mdserver1 32 threads / 91 GiB,
   ai-server 64 threads / 373 GiB) the gate and build leases together never pass the worker threads (24 and 48).
2. The control-plane reserve is never given to a worker: with the worker budget full, a gate, a build and a worker
   tab are refused or queued, and a control-plane tab is admitted here on the reserve.
3. A `tab create --host auto` that fits no host returns `202 queued` with a ticket, a position and the measured and
   expected figures, and creates no tab. It does not fall back to this host.
4. A queued ticket is admitted when capacity frees: its re-ask after a release takes the slot, in arrival order.
5. A harness request holds at most its share. A waiting harness ticket under its share is admitted before later
   product tickets. Product work never loses more than the share to harness work.
6. Every refusal and every queued answer states measured against expected (`budget threads 44/48 used, needs 8`,
   `measured 6.0 GiB free, needs 12.0 GiB`, `position 2 of 3`).
7. The budget, the reserve, the envelopes and the share come from fleet config. Each key is checked when written.
8. Advisory compatibility: `pool acquire` without `--queue` answers as today (admitted or `409 pool-full`). A plain
   `tab create` (no `--host auto`) does not ask the pool. Old lease notes (`pool mem=8`) still read.
9. Each new branch has a mutation that a test kills (§7).

### Defaults (documented, from the measured hosts)

Reserve default: `max(2, ceil(25 % of threads))` threads and `max(4, ceil(15 % of memory))` GiB.

| Host | Threads | Memory | Reserve | Worker budget | Gates (8 threads) at most | Agent tabs (2 threads) at most |
|---|---|---|---|---|---|---|
| mdserver1 | 32 | 91 GiB | 8 threads, 14 GiB | 24 threads, 77 GiB | 3 | 12 |
| ai-server | 64 | 373 GiB | 16 threads, 56 GiB | 48 threads, 317 GiB | 6 | 24 |

| Kind | Envelope threads | Envelope memory (GiB) |
|---|---|---|
| gate | 8 | 8 |
| build | 8 | 8 |
| mutation | 8 | 8 |
| browser | 2 | 4 |
| test-service | 2 | 4 |
| tab | 2 | 4 |

A request's `--mem` raises the memory envelope; `--threads` sets the thread envelope. Neither host has a cgroup CPU
limit (measured). ai-server reached load 147 on 64 threads; mdserver1 runs at load 55-67 on 32 threads. On those
reads the measured CPU check refuses new work on both hosts until the load falls under the host's threads; the owner
can raise `pool.budget.<host>.max-load` per host.

## 6. Launchers that must still migrate

The pool stays advisory: a launcher that never asks is not placed and its work is not in the ledger (only in the
measured check).

| Launcher | Today | Migration |
|---|---|---|
| plain `tab create` (no `--host`) | creates the tab here, no pool | worker tabs move to `--host auto`; coordinators to `--host auto --class control-plane` |
| `engineering/skills/scripts/gate.sh` (`gate.route`, `gate.remote-repos`, `gate.slots`) | its own semaphore and routing (ADR-0039 §6) | `pool acquire --kind gate --queue --class product` |
| `remote-gate.sh` (`gate.remote-hosts`, api-slot queue) | its own host queue | `pool.gate-host.<host>` + `pool.slots.<host>.gate` |
| treasury-v2 `tools/slot.sh`, `tools/gate-remote.sh` | own slots | `pool acquire --kind gate|build --queue` |
| mutation runs (mutmut / Stryker in story workers) | run in the worker tab, unbudgeted | `pool acquire --kind mutation` |
| evaluator Chrome (ADR-0040), chrome-devtools MCP | started by the tab | `pool acquire --kind browser` |
| local-dev-stack / test containers (Postgres, LocalStack) | `docker compose up` in the tab | `pool acquire --kind test-service`, and pass the envelope to `docker --cpus --memory` |
| kodit indexing, curator evaluation, harness experiments | unbudgeted | `pool acquire --class harness` |
| `/run-tabs` worker tabs | `tab create` here | `tab create --host auto` (queues) |

## 7. Mutation record

Filled in by the TDD pass: each mutation was applied by hand to the final tree, the named test failed, and the
mutation was reverted.

(see below)
