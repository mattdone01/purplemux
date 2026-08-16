# Test fixtures

## `grok-session/`, `grok-session-tools/`

Two real **Grok Build 1.0.4** sessions recorded on 2026-08-16, copied out of
`~/.grok/sessions/<url-encoded cwd>/<session-id>/`. They are the contract
`src/lib/session-parser-grok.ts` is written against — the ACP update schema is
not documented line by line, so the recording is the specification.

| Fixture | Recorded with | Covers |
|---|---|---|
| `grok-session/` | `grok -p "Reply with exactly the word OK…" --output-format json` | `user_message_chunk`, `agent_thought_chunk`, `agent_message_chunk`, `turn_completed` usage and cost |
| `grok-session-tools/` | a headless turn that edits a file and runs a shell command, `--always-approve` | the above plus `tool_call` and both flavours of `tool_call_update` — the non-terminal one that refines a call's title, and the terminal one that carries `status` and `rawOutput` |

Copied per session: `updates.jsonl`, `summary.json`, `signals.json`,
`events.jsonl`, `rewind_points.jsonl`.

Deliberately **not** copied: `chat_history.jsonl` (the raw model messages,
including encrypted reasoning blobs — nothing reads it), `prompt_context.json`
and `system_prompt.txt` (loaded instructions), and the `.lock` siblings.

`costUsdTicks` in `turn_completed` is USD × 10^10. That scale is not documented;
it was fixed by a headless run that printed both `total_cost_usd 0.01009732` and
`total_cost_usd_ticks 100973200`.
