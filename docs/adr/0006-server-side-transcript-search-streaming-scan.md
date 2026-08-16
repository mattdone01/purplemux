# ADR-0006: Server-side transcript search is a bounded streaming scan with a text cache, not an index

_Epic decision id: ADR-007 (see `_output/purplemux-mobile/architecture.md`)._

## Status
Accepted (2026-08-16, epic `purplemux-mobile`)

## Context
purplemux had no transcript search. A phone client caches recent sessions on device and searches
them locally (mobile ADR-007), but it cannot search what it never synced — the archive on
ai-server is 2.2 GB across ~950 sessions in three stores: `~/.claude/projects`, one claude-home
per workspace under `~/.purplemux/workspaces/*/claude-home/projects`, `~/.codex/sessions`, and
grok's SQLite store at `~/.grok/grok.db`. FR-10/FR-11, NFR-1.

## Options

1. **Build an SQLite FTS5 index server-side.** Fastest queries; but it adds a second store to keep
   in step with four transcript sources, an ingestion path, an invalidation story, and a migration
   — before anyone has used the feature once. Rejected for this epic.
2. **Read the parsed entries the timeline already produces, per request, with no cache.** Simplest;
   but every query re-parses the whole archive, measured at ~37 s. Rejected.
3. **Streaming scan with a per-file text cache and a work budget.** Extract the searchable text of
   a session once per revision, keep it in an LRU on `globalThis.__ptSearchCache` (200 MB), test the
   raw bytes before paying to parse a session, and stop the scan on a work budget. Chosen.

## Decision
Option 3. `GET /api/timeline/search?q=&workspaceId=&provider=&limit=&offset=` returns
`{hits:[{sessionKey, seq, entryId, type, timestamp, snippet, workspaceId, workspaceName}], total,
truncated}`. Three properties are load-bearing:

- **The response is index-agnostic.** A hit is `(sessionKey, seq)` — the address ADR-0001 gave the
  history route — so the scan can be replaced by FTS5 later with no client change. No filesystem
  path crosses the wire.
- **Parse only what can match.** A session whose raw bytes do not hold every term cannot hold an
  entry that does, so it is never parsed. Terms that a JSON record would escape (a quote, a
  backslash, punctuation) skip the pre-filter and are answered by parsing, which is slower and
  exact.
- **The scan is bounded, and says so.** `MAX_SCAN_HITS` (1 000) and `MAX_SCAN_COST` (384 MB of
  bytes-read-equivalent, parsing charged 4×) stop a scan that would outrun the latency budget.
  Sources are visited newest-first and hits rank the same way, so a stopped scan drops the oldest
  end of the archive, reports `truncated`, and leaves already-paged results in place.

Searchable text is `user-message`, `assistant-message`, `tool-call` and `tool-result` only
(`src/lib/entry-text.ts`); `thinking` is excluded deliberately. The server supplements the parsed
entry with the record's raw tool input and output, which `summarizeToolResult` truncates away — the
one field-level asymmetry with the on-device index.

## Consequences
Measured on ai-server (2.2 GB, ~950 sessions): a high-yield query 1.7 s cold and 0.13 s warm; a
parse-heavy two-term query 2.2 s; a query that matches nothing 2.1 s. Against a 200 MB synthetic
corpus a warm search is 0.19 s. A grok hit is not yet openable: `resolveSessionKey`
(`src/lib/session-resolver.ts`) accepts `claude` and `codex` only, so `GET /api/timeline/history`
rejects a `grok:` key — the grok branch of the history route is the complementary half of ADR-0005
and is not yet written.

Source of truth for the epic: `_output/purplemux-mobile/architecture.md` (nomupay workspace).
Related: `docs/adr/0001-stable-entry-ids-seq-and-history-cursor.md`, `research.md` "API contract".
