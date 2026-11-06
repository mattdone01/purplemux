/**
 * Machine codes carried beside `error` on CLI route error bodies (ADR-0016):
 * `tab-not-found`, `session-not-running`, `readiness-timeout`,
 * `target-changed` and `forbidden` so far; later routes add their own.
 *
 * `bin/cli.js` maps each code to an exit code through one table, so a caller
 * can tell a failure it must never retry (the tab is gone) from one it may
 * retry (the agent is still booting). The `error` strings and the HTTP statuses
 * stay as they were: the web UI and the phone read them (ADR-0004, additive
 * wire changes only).
 */
/** The supported path a foreign-mutation denial names (ADR-0014, ADR-0029). */
export const FOREIGN_MUTATION_HINT = 'Use coordinator notes for cross-workspace requests (from the owner-granted tab: send a note as owner), or local human controls.';

export const TAB_NOT_FOUND_BODY = Object.freeze({ error: 'Tab not found', code: 'tab-not-found' as const });

/**
 * A remote tab's host did not answer over ssh (ADR-0022): `remote-host-unreachable`, retryable (exit 6), never "the
 * tab is gone". A write that may have run before ssh failed is `remote-write-outcome-unknown` (exit 1): the caller
 * reads the pane before any retry, because a blind retry may type the prompt twice (story 11 review r1, finding 1).
 */
export const remoteHostUnreachableBody = (err: { message: string; host: string; outcomeUnknown?: boolean }) => ({
  error: err.message,
  code: err.outcomeUnknown ? ('remote-write-outcome-unknown' as const) : ('remote-host-unreachable' as const),
  host: err.host,
});

/**
 * A remote create refused because the CLI kit does not run on the host (harness-flow-loop-2 story 12): 502, exit 1
 * (ADR-0016). `line` names the cause (for example `Error: Cannot find module './x.js'`); no agent started.
 */
export const remoteKitBrokenBody = (err: { message: string; host: string; line: string }) => ({
  error: err.message,
  code: 'remote-kit-broken' as const,
  host: err.host,
  line: err.line,
});

export const targetChangedBody = (tabId: string) => ({
  error: 'agent-target-changed' as const,
  code: 'target-changed' as const,
  tabId,
});
