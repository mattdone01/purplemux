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
