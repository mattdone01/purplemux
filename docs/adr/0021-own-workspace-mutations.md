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
