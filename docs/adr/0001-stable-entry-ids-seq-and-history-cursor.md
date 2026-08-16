# ADR-0001: History sync contract — deterministic entry ids, per-session `seq`, `sessionKey` addressing, forward cursor, `sessionRevision`

_Epic decision id: ADR-003 (see `_output/purplemux-mobile/architecture.md`)._

## Status
Accepted (2026-08-16, epic `purplemux-mobile`)

## Context
 research §1.4 — `nanoid()` ids (~27 sites in each parser), no forward cursor, path-addressed reads, Codex `replaceEntries`. FR-5/FR-6, NFR-1/2. Research Q6/Q7.

## Options

1. **Ship JSONL byte ranges to the phone and parse there** — no server change; but the phone would need `jsonlPath` (a filesystem path over the wire), both parsers ported to Dart and kept in sync (the Codex parser is ~1 300 lines and stateful), and every future entry type ported twice. Rejected.
2. **Byte-offset forward cursor (`afterByte`) on the existing `entries` route** — small change; but byte offsets are invalidated by compaction/rewrite with no signal, Codex correlation still breaks across pages, and the phone still constructs paths. Rejected.
3. **Server-side stable ids + `seq` + `sessionKey` + `GET /api/timeline/history?afterSeq` + `sessionRevision`** — the parser emits `id` from the Claude record `uuid` (`session-parser.ts:51` already parses it) or `sha1(sessionId:byteOffset:ordinal)` for Codex/synthesised entries, plus a per-session ordinal `seq`; a new route resolves `sessionKey := <provider>:<global|wsId>:<sessionId>` to a path server-side and pages forward; `sessionRevision` (`inode:size:mtimeMs`) tells the client to restart when the file was rewritten. Codex correlation is kept by holding `ICodexParseState` per session in a `globalThis.__ptCodexHistoryState` LRU (64 sessions); if a page boundary still cannot be correlated the route falls back to `hasMore:false` + full session + new revision (documented degraded mode). 

## Decision
 Option 3. Also add `seq` and `sessionKey` to `timeline:init`/`timeline:append` (additive) so live appends upsert by `(sessionKey, seq)`.

## Consequences
 the web timeline gains stable React keys for free; `GET /api/timeline/entries` stays for the web client; the phone never sees a filesystem path; the on-device schema keys entries by `(session_key, seq)` (ADR-007); search hits deep-link by `(sessionKey, seq)` (story 04/17). Risk: `seq` for a session that is later compacted → revision bump → phone re-syncs that session (bounded by NFR-7 cap).


Source of truth for the epic: `_output/purplemux-mobile/architecture.md` (nomupay workspace). Related: `research.md` "API contract".
