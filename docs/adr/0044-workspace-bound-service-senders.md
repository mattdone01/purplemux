# ADR-0044: Workspace-bound service senders, granted to note one workspace

## Status
Proposed (2026-11-09, story vel-LP-2). Builds on ADR-0010 (caller identity), ADR-0013 (notes) and ADR-0029
(owner grants). The design consult ruled for a workspace-bound service sender over admitting the admin token.

## Context
The lessons-pass timer (`improve-lessons@<ws>`) has no tab. It sends its note with the admin token, and
`admissionFor` refuses a tab-less sender for a cross-workspace note. The timer therefore cannot note the
Portfolio Scrum Master. To admit admin would let every process of the user note every workspace.

## Decision (the design, 10 lines)
1. Registry `~/.purplemux/service-senders.json` (0600, written on the server host by the owner, no HTTP write
   route): `{ senders: [{ name, workspaceId, noteTarget, tokenSha256 }] }`. The entry is the grant.
2. A token whose SHA-256 matches an entry resolves to `{ type: 'workspace', workspaceId, service }`. The match
   runs only after the admin, workspace and tab tokens miss. The caller has no tab, and a session header never
   lends one.
3. The registry fails closed: missing, unparsable, or group- or world-writable grants nothing. An invalid entry,
   and every entry that shares a name or a token hash, is dropped.
4. `admissionFor`: coordinator and local come first (a note into the home workspace stays `local`). Then a service
   caller is admitted as `{ mode: 'service', service, targetWorkspaceId }` only for `toWorkspace === noteTarget`.
   Every other target, an epic target included, is `forbidden`. Admin and the plain workspace token stay refused.
5. `recipientOf` routes a `service` note to the target coordinator only when the stored admission matches the
   target and the sender, and while `serviceGrantActive` still holds. Else it is `policyblocked`
   (`service-admission-target-mismatch`, `service-grant-inactive`). The paste preflight rechecks this.
6. The sender is `{ workspaceId: home, tabId: null }`, so it counts against the one existing 50-open-note cap of
   that identity, shared with the home workspace's other tab-less senders. There is no new budget.
7. `from.service` records the sender; the view label is `service <name> (<ws>/workspace)`. The inbox line is unchanged.
8. `scripts/service-sender-grant.ts` adds or rotates an entry and writes the token to a 0600 file, never to stdout.

## Consequences
- The timer sets `PMUX_TOKEN` from its token file for the note send; the CLI already prefers `PMUX_TOKEN`.
- A service token has the authority of its home workspace's tab-less workspace token, and no more.
- Revocation is the removal of the entry (`--revoke`). A queued note then stops at routing or at the paste preflight.
- Who can write `~/.purplemux` can grant a sender. That is the same trust boundary as `workspace-tokens.json`.
