# ADR-0049: Who may coordinate a workspace, and when it is woken

## Status
Accepted (2026-11-17). One Opus 5.5 xhigh design consult, APPROVE-WITH-CHANGES; built to all seven of its rulings.
It records the rule that #92 (16 Nov 2026) changed in code only: before #92, a comment in
`src/lib/orchestration-recovery.ts` refused every remote tab and named ADR-0022, which has no coordinator text.
It also fixes two defects seen on 16 Nov: the keeper typed a heartbeat into a parked coordinator every ~11 min, and
`orchestration off` refused with "active agent tab: <the caller itself>".

## Context
A workspace has one coordinator: `workspace.orchestration.orchestratorTabId`. The watchdog nudges it. The keeper
types an idle heartbeat into it, and Mission Control delivers the owner's answers to it. Recovery moves the role
only when the incumbent is positively absent.

The owner now puts each team lead on its own team host, because the link from the control host to the team hosts
is slow. #92 removed the refusal for remote tabs and kept two proofs: a strict process proof on the host, and a
refusal when the state is unknown. Two parts were still missing. The first was a written rule. The second was the
cases that a remote coordinator adds:

- the host does not answer;
- input that is typed over ssh;
- the heartbeat;
- the process proof.

## Decision
1. **Who may coordinate.** Only an agent tab of the workspace that is not an evaluator (ADR-0040) may coordinate,
   on this host or on a remote host. A remote tab is always a claude-code tab (ADR-0022), and its host must be on
   `remote.hosts` when it is designated. That check runs before any ssh. If the list is unreadable, the result is
   409 `orchestrator-state-unknown`. If the host is not on the list, the result is 409
   `orchestrator-candidate-invalid`. A coordinator that is already in place is not checked again.
2. **Proof, never cache.** A candidate must observe `present` twice, with the same identity, before the commit. A
   remote tab is observed on its host (`observeRemoteProviderProcess`: pane id, pane pid, provider pid and start
   time). A failed or timed-out ssh is `unknown` and is never `absent`. Cached CLI state is never evidence
   (ADR-0021).
3. **Absent is a positive answer.** The remote walk prints `absent` only when two things hold: the host's tmux
   answered, and the process table of the pane process is readable. That means `/proc/<pid>/stat` and
   `/proc/<pid>/task/<pid>/children` (a kernel without CONFIG_PROC_CHILDREN has no children file). In every other
   case the result is `unknown`. So an own-workspace recovery never replaces a live coordinator whose host hides
   its processes.
4. **The caller's own turn is not work.** `orchestration off` (and clear) reads fresh work evidence. The tab of a
   verified caller is left out, because its busy turn is the call itself. Its registered jobs, the leases, the
   standup and every other tab still count. A human or unverified caller excludes nothing.
5. **A parked coordinator gets no heartbeat.** The keeper types no heartbeat and sends no stall alert when all of
   these hold:
   - the coordinator's current stop (its turn-marker record is the stop that is its last event) ended
     `CHECKPOINTED:`;
   - no worker is busy and no registered job is live;
   - the workspace holds no unexpired lease, except the reservation kinds `num:` and `pool-cancel:`;
   - the workspace has no watch;
   - no urgent event for the coordinator in the last 24 h is still untyped.

   The last condition keeps the heartbeat as the backstop for an urgent paste that failed, because the router does
   not retry one. If any source is unreadable, the coordinator is not parked. While the coordinator is not parked, a
   `CHECKPOINTED:` answer to a heartbeat does not start a new episode: beat 3 goes to the owner as a stall alert,
   instead of a new beat every window.
6. **Mission Control binds a remote coordinator by its host's proof.** A remote pane has no local pid, so before this
   change no run could bind to a remote tab, and no owner answer reached one. `inspectLiveTab` now proves a remote
   tab with a fresh strict observation on its host. A host that does not answer backs off for 30 s with the pane
   scans, so the 5 s rebind retry does not ssh a dead host on each pass. Discovery's `alive` uses the poll's own
   rule over the pane scan that it already read: the provider in the foreground, or a kept `present` proof that it
   reads without consuming. It sends no ssh of its own. The paste-time preflight still runs the fresh proof.

## The cases a remote coordinator adds

- **The host does not answer.** Recovery and handoff refuse with `orchestrator-state-unknown`. The incumbent's own
  verified handoff and a human replace still work, but a candidate must be proven. Mission Control answers stay
  queued: the preflight refuses `bound-agent-not-live` without a claim, so nothing is typed, and the inbox backoff
  asks again (10 s up to 5 min, held after 30 refusals or 24 h, a held item tried every 5 min). An urgent nudge whose
  paste fails is recorded as untyped, and the coordinator then cannot park (§5). An idle coordinator keeps its
  cached `idle`, so the keeper counts beats 1 to 3 and the owner receives a stall alert in about 30 min. When the
  host answers again, the next observation decides, and a held digest is typed when the tab is at its prompt.
- **Input typed over ssh.** A nudge is confirmed by the pane. A failed check counts as delivered, so the nudge is
  never typed twice. A digest whose text was typed but whose Enter failed can be typed again. Mission Control keeps
  exactly-once: an uncertain send is held as `transport-uncertain`, a text left in the composer is held, and a row
  still `dispatching` at a restart is held.

## Consequences
- A team lead on its team host can be its workspace's coordinator and receive the owner's answers.
- A coordinator that checkpoints with nothing in flight is quiet until a nudge, a note or an answer wakes it, or a
  lease, watch or worker appears.
- Follow-ups, not built here:
  - (a) a router retry for an untyped urgent row, for every tab. This needs its own design against double typing.
  - (b) a stall alert that names a host which did not answer.
