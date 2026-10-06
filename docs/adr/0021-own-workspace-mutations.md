# ADR-0021: Own-workspace agent mutations

Agent tab and workspace mutations require a token scoped to the target workspace.
Peer entries, legacy drive grants, and the global CLI token cannot authorize them.
Read access retains its existing scope. Legacy `drive` grant records remain compatible,
but their effective cross-workspace capability is read-only.

Human UI mutation routes authenticate a session cookie and require same-origin requests.
The proxy does not admit global-token UI mutations. Mixed launch routes authenticate
workspace tokens or genuine human cookies explicitly; loopback launch receipts retain
their generation and process checks. CLI aliases use the same handlers.

CLI tab lookup and listing read existing layouts without initializing sessions or writing
repair backups. A missing layout is empty; unreadable or invalid layouts fail unavailable.

Denials direct agents to coordinator notes or local human controls. This is supported
harness policy, not Unix-account or credential-file isolation. Revision CAS, coordinator
recovery, strict death observations and lifecycle serialization are a separate increment.

## Explicit local recovery and mapping revisions

All CLI, human UI and human-start mapping changes use one shared transaction. Requests carry `expectedRevision`; reads expose a missing legacy revision as zero without a migration write. Missing, malformed and stale preconditions fail before side effects. Compare the revision before deciding an operation is a no-op; increment once per semantic change and preserve unrelated fields. Human start checks before creating a tab and holds ownership through creation/commit. A persistence failure reports the created undesignated tab and queues no kickoff.

Lock order is workspace mapping write, sorted incumbent/candidate lifecycle locks, strict observations, then the workspace-store lock for CAS persistence. No global layout/store lock covers external process probes. Dispatch and supported close/restart/pane-close/reconnect/resume paths retain workspace mapping read guards; workspace deletion takes a write guard. Queued workspace writers precede later readers. Whole-server human reset uses a separate global barrier against mapping commits, then calls its initialization/resume internals without recursively acquiring workspace guards. All shared gates use globalThis across server and Next module graphs.

Recovery requires a live local agent with existing model proof and a vacant or positively absent incumbent. A configured incumbent missing from the layout has no trustworthy retained binding and remains unknown; authenticated human replacement with CAS can resolve it. A disabled live incumbent still owns its mapping. A launch-verified incumbent may hand off; an unverified asserted session cannot. Explicit human replacement leaves the previous process running. No new bootstrap, lease transfer, note acknowledgement, restart, or job revival follows designation.

Clear/off requires the existing unfinished-work classifier to return complete with fresh, complete observations. Waiting for human input retains the mapping and suppresses idle heartbeats. Conflicts refresh UI state and require a new explicit action; the CLI reads once and writes once. These locks linearize supported harness operations in this Node process. Manual process starts and file edits under the shared Unix account remain outside that boundary.


### Pending lifecycle evidence (recovery review correction)

Agent launch commands persist a server-owned `orchestrationActivity.launch` in the tab before terminal input. Browser preparation must finish successfully before input is queued. Restart and delayed resume use the same evidence. A shell without a provider remains unknown while a launch is pending, including after server restart.

Prompt delivery writes a unique pending turn before the first text byte or Enter, inside the dispatch mapping guard. Failed or uncertain text or Enter delivery retains the marker and ownership. Accepted, timestamped prompt-submit hooks bind the turn to the current strict pane/provider identity; a later matching stop or interrupt retires it using a generation compare-and-set. Hook occurrence time is captured before HTTP delivery, so delayed live hooks obey the same ordering as replay. Session-start acknowledges launch readiness only. No timer proves completion.

Legacy hooks without occurrence time, unreadable process identity, or mismatched runtime generations cannot complete pending work. They can leave conservative pending evidence. An authenticated managed close/reap is the abandonment path: it excludes concurrent dispatch/restart, refuses `keep-processes` for pending work, and requires a Linux reap with no survivors plus strict session absence before removing the tab. Failed or uncertain reaping retains the record. Legacy Claude/Grok hooks still lack provider-supplied generation nonces; timestamp and current process identity checks are evidence under the existing shared Unix account trust boundary, not cryptographic attribution.

### Browser and raw terminal input (review R3)

Non-Codex launch preparation atomically persists the intended agent panel type and pending launch generation. An optimistic UI type PATCH is not launch proof. Missing or invalid intended agent type is refused before a launch command is returned or submitted.

The desktop and mobile WebInputBar submits prompts through the cookie/origin-authenticated human send route, including attachment-only Enter. Attachment pastes are awaited through that route before final submission. Target session identity is checked. Pending work is persisted before the first prompt byte, so text or Enter delivery uncertainty retains ownership.

Raw terminal bytes have no authoritative prompt boundary. Each nonempty PTY input frame requests the mapping guard on receipt and records unresolved activity before forwarding any bytes, preserving frame order. Repeated frames in an unresolved generation coalesce without another layout write. Resize and heartbeat frames are not input. Ordinary nonagent terminal bytes pass unchanged. Persistence failure forwards no unrecorded bytes and produces a visible client error.

An old in-flight stop cannot clear newer raw input: only a subsequent accepted submission bound to the same current process identity, followed by its matching stop/interrupt, completes that generation. No Enter, paste, arrow, or Escape semantics are inferred. Arrow/Escape-only interaction may therefore retain ownership conservatively; the clear/off conflict explains that an accepted matching turn or confirmed close/reap is needed. There is no timer-based clearing.
