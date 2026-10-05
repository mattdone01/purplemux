# ADR-0014: Portfolio scope — a human-granted, verified-tab drive grant

> Superseded for mutation authority by ADR-0021. Existing `drive` records now provide read access only; they never authorize foreign agent mutations. No migration or token rotation is required.

- **Status**: Accepted (story 11, 2026-09-26)
- **Context source**: `_output/purplemux-portfolio-coordination/architecture.md` (nomupay workspace), learning L13

## Context
A cross-workspace orchestrator needs to type into tabs of other workspaces. The only route was reading
`~/.purplemux/workspace-tokens.json`, which the drive guard calls "not evidence of belonging".
`canDriveWorkspace` allowed the caller's own workspace only; the admin token gets no drive by design
(every agent process can read it), and `allowedPeers` grants reads, never input.

## Options
1. *The admin-token CLI creates grants.* Convenient, but the admin token is a file every agent process can
   read, so a grant made with it is not evidence of a human.
2. *`allowedPeers` gains a drive bit.* Workspace-to-workspace, not tab-bound: any worker tab of the grantee
   workspace could drive; it widens a read grant into input.
3. *A grant created only through the human web session plus a step-up password*, bound to one verified tab,
   expiring, revocable, dying with the tab, audited on creation, revocation, expiry and every use.

## Decision
Option 3.

- **Human gate.** `POST /api/grants` needs the web session cookie (`requireMissionHuman`), this server's
  Origin (`requireMissionSameOrigin`) **and** the purplemux password, checked against its scrypt hash. The
  session JWT alone is not proof: its signing secret sits in `config.json` with the same uid as every agent;
  the password is stored only as a hash. Wrong or missing passwords are refused (`grant-password-invalid`,
  403) and audited; 5 failures in 10 minutes lock grant creation for 15 minutes (`grant-locked`, 429), even
  for the right password. Password checks run one at a time, so a burst of concurrent guesses cannot pass
  the lock check before a failure is counted (review r1). No CLI token reaches these routes (the handlers
  require the session; a CLI token passes the login proxy but not the handler).
- **Revoke** (`DELETE /api/grants/<id>`) needs the session and the Origin but **not** the password — a
  deliberate deviation from the architecture's table (review r1): revoking only takes power away, and a
  password check there either lets a grantee lock the human out of revoking (5 wrong guesses every 15
  minutes) or, exempt from the lockout, becomes an unlimited guessing channel. A process that forges a
  session can therefore revoke grants — a denial of the grant, never an escalation.
- **The grant.** `~/.purplemux/grants.json` (0600, tmp + rename, one lock):
  `{ id: g-…, capability: 'drive', grantee: { workspaceId, tabId }, workspaces[], reason, createdAt, createdBy
  (session subject), expiresAt (default 24 h, max 7 d), revokedAt, revokedBy, revokeReason, expiryNotedAt }`.
  The grantee must be a tab with a **launch** identity (a tab token bound at session creation, ADR-0010);
  a tab with a hook-time identity or none gets `grant-tab-unverified` (409) — recreate the tab.
  The grantee's own workspace may not be listed (it drives that already).
- **Predicates.** `canDriveWorkspace(scope, ws)` = own workspace, **or** (`scope.tabVerified` and an active
  grant for this exact tab over `ws`). `canAccessWorkspace` also admits that grant. The grants sit in a cache
  on `globalThis` (the server bundle and every API route share it) so the predicate stays synchronous; every
  write refreshes it. A malformed or unreadable `grants.json` means **no grants** and refuses every write
  until it is repaired or moved aside (fail closed; the CLI list answers 500 `grant-store-unreadable`).
- **Mission Control producer events** (`/api/cli/mission-control/events`) use `isOwnWorkspace`: a grant
  never lets a portfolio tab write another workspace's MC events.
- **Lifetime.** A grant ends when revoked, at expiry, or when its grantee tab closes (`tab-closed` →
  `grantee-tab-closed`; at boot, a grantee tab missing from a readable layout ends its grants too; a
  workspace whose layout cannot be read keeps them as unknown). Ended grants are listed for 7 days, then
  pruned.
- **Reach and audit** (`~/.purplemux/audit/coordination.jsonl`): `grant-created`, `grant-revoked`,
  `grant-expired` (once, even for a grant pruned later), `grant-password-invalid`, `grant-locked`, and
  `grant-used` for every request that was allowed ONLY because of a grant, with the route, target workspace
  and target tab (the route's `tabId`, or the body's for the launch routes):
  - the input routes behind `authorizeWorkspaceInput` (send, steer, bg and probe writes, tab PATCH, the
    Claude/Codex launch routes);
  - any non-read request behind the read gate `authorizeWorkspace` (tab close, tab create, browser
    actions) — review r1: `canAccessWorkspace` admits a grant, and those routes change things;
  - except the workspace settings routes (`/api/cli/workspaces/<ws>/…`: directories, orchestration,
    standup), which a grant never reaches (403): it drives a workspace's tabs, not its settings.
  Reads through a grant are not audited.
- **Denials name the fix.** A grantee calling without its launch identity (a hook-time token or the
  session fallback) gets 403 `grant-tab-unverified` naming the grant and "recreate the tab"; any other
  refusal is the unchanged `forbidden`.
- **CLI.** `purplemux grant list [--json]`, read-only (`GET /api/cli/grants`): the admin token sees every
  grant; a workspace or tab token sees the grants its workspace holds or is driven under. The web UI (dialog,
  badge) is story 28.

## Consequences
- Without a grant every predicate answers exactly as before (NFR-1; the existing auth tests and a grant-free
  predicate test pin it).
- A portfolio orchestrator must be a tab created after per-tab tokens (story 01) and the human needs the web
  UI (or a phone browser) to grant; the CLI can only list.
- Threat model: the step-up password is evidence of human intent at the API, not a boundary against a
  same-uid process that edits `grants.json` or replaces the hash in `config.json` directly; such file writes
  are outside this epic's threat model (cooperating agents). The scrypt hash is readable by that uid and the
  password may be as short as 4 characters (`MIN_PASSWORD_LENGTH`), so "cannot recover the password" holds
  only for a strong password. The hash is read from `config.json` on each check, so a swapped hash takes
  effect at once; reading the boot-time value would need a restart first (hardening not done). Stated so no
  reader over-trusts a grant.
