# ADR-0030: Spend read model — tokens and estimated cost per workspace, tab, day, model and role

## Status
Proposed (2026-10-26, epic `purplemux-flow`, story 07).

## Context
The owner asked where the tokens went. `GET /api/stats/overview` aggregates Claude usage per day and model only
(`src/lib/stats/stats-cache.ts`); no stats code knows a workspace, a tab or a role. Measured on 2026-10-26:
- Workspace attribution is exact for Claude: each workspace's transcripts live under
  `~/.purplemux/workspaces/{ws}/claude-home/projects` (`listClaudeProjectsDirs`).
- **Subagent transcripts are not counted anywhere.** `collectJsonlFiles` reads only the top level of each project and
  skips `agent-*.jsonl`. Claude Code writes subagent transcripts to `<project>/<sessionId>/subagents/agent-*.jsonl`:
  2,669 files and 3,752 MB, against 389 main files and 3,059 MB. Each subagent line carries the parent `sessionId` and
  `isSidechain: true`. (Bytes measured; the token share is not measured.)
- Tab attribution needs a session-to-tab binding. Session history keeps 200 entries fleet-wide
  (`src/lib/session-history.ts:10`), a few hours of a 50-tab workspace. The server learns every binding in one function,
  `updateTabAgentSessionId(sessionName, provider, sessionId)` (`src/lib/layout-store.ts:655`), and forgets it at the
  next session.
- Codex sessions live in the global `~/.codex/sessions`, so even the Codex workspace needs the binding.
- The transcripts total about 6.8 GB; one Node process serves every request, so a full parse per request is not possible.

## Options considered
1. **Extend the stats cache with workspace and tab keys.** One cache; but its unit is a whole day reparsed, its version
   bump drops every user's cache, and it would still miss subagents.
2. **Parse on request with a cache keyed by file size and mtime.** Simple; the first request after a deploy blocks the
   event loop for minutes.
3. **A separate incremental index built in the background, one shared usage extractor, and a durable binding store.**

## Decision
Option 3.

1. **One extractor.** `readClaudeUsage(entry)` in `src/lib/stats/claude-usage-line.ts` (new) returns `{messageId, model,
   sessionId, sidechain, day, input, output, cacheRead, cacheCreation, cacheCreation5m, cacheCreation1h}` or null, with the
   stats cache's rules (model present and not `<…>`, usage present, `day` = the UTC date of `timestamp`). `parseDaysFromFile`
   is refactored to call it; its existing tests pin that the stats answer does not change.
2. **Files.** Claude main files are `collectJsonlFiles()` (unchanged). Claude subagent files are
   `<project>/<sessionId>/subagents/*.jsonl` (new collector). The workspace is the one whose `claude-home/projects` holds
   the file; `~/.claude/projects` is the workspace key `global`. Codex and Grok files come from their existing readers.
3. **Bindings.** `~/.purplemux/session-tabs.json` (new, 0600, tmp + rename, one lock): `{version: 1, bindings:
   {"<provider>:<sessionId>": {workspaceId, tabId, firstSeenAt, lastSeenAt}}}`. `updateTabAgentSessionId` records each
   non-null binding after its layout write; a failure is logged and never fails the hook path. At start the store is
   seeded from session history and from every layout's current session ids. Bindings unseen for 90 days are pruned.
4. **Index.** `~/.purplemux/stats/spend-index.json` (new, version 1, 0600). Per file: `size, mtimeMs, ino, offset` (the
   end of the last complete line read) and buckets `{day, model, sessionId, sidechain, input, output, cacheRead,
   cacheCreation}`. A message id counts once per file (the stats rule); the index keeps the last 256 ids per file so a
   tail read does not count a message twice across a boundary. A grown file is read from `offset`; a shrunk file or a
   new inode is read again from 0. The indexer runs on `globalThis.__ptSpendIndexer`: it starts 120 s after boot, takes
   one file at a time, newest mtime first, yields with `setImmediate` every 1,000 lines, and JSON-parses only lines that
   contain `"type":"assistant"`. It writes the index at most every 60 s and at the end of a pass, then rescans every
   5 min. A request never parses a transcript. Codex and Grok session files are read again when their size or mtime
   changes; their usage counts on the session's start day (`dayBasis: 'session-start'`, an approximation the view states).
5. **View.** `ISpendRow {key, label, providerId: 'claude'|'codex'|'grok'|null, inputTokens, outputTokens,
   cacheReadTokens, cacheCreationTokens, totalTokens, sidechainTokens, costUsd: number | null, unpricedTokens}`.
   `ISpendView {workspaceId: string | 'all', from, to, by, generatedAt, totals, rows, unattributed: ISpendRow | null,
   roleBasis?: 'current-orchestrator', dayBasis: {claude: 'message', codex: 'session-start', grok: 'session-start'},
   index: {state: 'ready'|'indexing'|'unavailable', filesIndexed, filesTotal, indexedThrough: ms | null, error?}}`.
   `by` is `tab | day | model | role`, plus `workspace` on the all-workspaces human view. Days are UTC dates.
   Invariant, per `by` and per token field: `sum(rows) + unattributed = totals`. Usage whose session has no binding is
   `unattributed` (in its workspace when the path names one, else in the fleet total): never dropped, never 0.
   `role` rows are `orchestrator` (the tab that is the workspace's enabled orchestrator now) and `other`.
6. **Cost.** `calculateCost` / `calculateCostByFullId` (`src/lib/claude-tokens.ts`) per model. Tokens of a model with no
   price go to `unpricedTokens`; `costUsd` is the sum of priced tokens, and null when no token of the row has a price.
   The UI labels cost "est." and shows unpriced tokens beside it; it never prints $0 for an unknown price.
7. **Parity.** For each UTC day, the Claude non-sidechain tokens of the main files, summed over all workspaces, equal the
   stats cache's Claude tokens of that day. A fixture test runs both code paths over one tree. The spend view states the
   subagent share (`sidechainTokens`) separately, because the stats overview does not count it.
8. **Routes.** `GET /api/cli/spend?workspaceId=WS&since=YYYY-MM-DD&until=YYYY-MM-DD&by=…` (read scope on WS; default the
   last 7 UTC days, `by=tab`; a range over 92 days or a bad date → 400 `invalid-request`).
   `GET /api/mission-control/spend?workspaceId=WS|all&period=today|7d|30d&by=…` (human session). Both answer
   `ISpendView`. `GET /api/mission-control/burndown` gains `tokensByDay?: [{day, totalTokens, sidechainTokens}]` for the
   burndown's workspace. CLI: `purplemux spend show -w WS [--since D] [--until D] [--by tab|day|model|role] [--json]`.
9. **Faces.** A Mission Control "Spend" tile (today and 7 d: tokens and est. cost; the top 5 tabs), and a tokens line on a
   second axis of the burndown chart. While `index.state` is `indexing`, both show "indexing n of m files" and mark the
   numbers partial.

## Consequences
- The owner gets per-tab and per-role spend, subagents included, without a new transcript reader.
- Spend before the binding store existed is attributed to its workspace and shown as unattributed per tab; it never moves
  to a guessed tab.
- The first full index after the deploy takes minutes of background CPU; requests answer `indexing` until it ends.
- `GET /api/stats/overview` is unchanged; a later change may add subagent usage to it.
- Non-goal: budgets, spend alerts and cost caps.
