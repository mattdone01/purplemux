/**
 * How the server knows which tab is calling (ADR-0010, story 36).
 * - `launch`: the server bound the tab token to the tab when it created the session — the only proof.
 * - `hook`: a tab created before tab tokens, given a token by its Claude SessionStart hook; the hook
 *   named its session, so this is the caller's word, resolved once per session.
 * - `session`: the caller's `X-Pmux-Session` header, per call.
 * - `none`: no tab named (the admin token, or a session outside the workspace).
 * `verified` is true exactly when the identity is `launch`.
 */
export type TCallerIdentity = 'launch' | 'hook' | 'session' | 'none';

/** Where a tab token came from: absent on every record minted before story 36 (all minted at launch). */
export type TTabTokenOrigin = 'launch' | 'hook';
