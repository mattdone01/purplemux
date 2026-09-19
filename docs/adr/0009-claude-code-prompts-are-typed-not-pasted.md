# ADR-0009: A prompt bound for Claude Code is typed, not pasted

## Status
Accepted (2026-09-19).

## Context
Every purplemux send path delivered a prompt as a bracketed paste: the web input bar, a paste into the browser terminal, `purplemux tab send`, the cookie-authed send route, steer, and the automated prompt dispatcher. That code did not change.

Claude Code changed. Version 2.1.278 wraps a paste in `<pasted_content>` and tells the model that the text may contain instructions the user did not write. The model then declines to act on a prompt that is wholly pasted. A `/run-tabs` worker brief and an operator prompt from the input bar both arrive wholly pasted, so both lost their authority.

Measured on 2026-09-19 against Claude Code 2.1.278, reading the session transcript for the wrapper:

| Delivery | Wrapped |
|---|---|
| Bracketed paste, 2 lines | yes |
| One `send-keys -l` burst, 5 KB, 61 lines | yes |
| One burst, 1,000 characters, 1 line | yes |
| One burst, 300 characters, 1 line | no |
| Per-line `send-keys -l`, `C-j` between lines, 5 KB | no, byte-exact |
| 200-character chunks, 4 KB, 1 line | no, byte-exact |
| 200-character chunks with 10 ms gaps and LF newlines, written to an attached client pty, 4.9 KB | no, byte-exact |
| `sendTypedText` end to end, 2.4 KB with a blank line, a leading dash, quotes, a 2,160-character line | no, byte-exact |

The wrapper follows the bracketed paste markers and, without them, the size of one input burst. The threshold sits between 300 and 1,000 characters.

## Options
1. **Keep the paste and tell the operator to confirm each prompt.** Every worker brief would need a human turn. Rejected.
2. **Type every prompt into every agent.** Codex and Grok take a paste as the prompt it is, and a paste is one tmux call where typed delivery is one call per chunk. Rejected: it changes two providers that have no defect.
3. **Type the prompt when the pane is Claude Code; paste otherwise.** Chosen.

## Decision
- `typed-input.ts` plans a prompt as keystroke steps: chunks of at most 200 characters, split on code points, with a newline step between lines. A tab becomes four spaces. Other control characters are dropped, because a typed control character is a key press.
- `tmux.ts` `sendTypedText` sends each chunk with `send-keys -l --` and each newline as `C-j`, 10 ms apart. Claude Code reads `C-j` as "insert a newline" and Enter as "submit".
- `agent-prompt-delivery.ts` picks typed or pasted delivery from the panel type of the tab that owns the session. Both send routes, steer, and the automated prompt dispatcher call it.
- `stdin-typed-writer.ts` sits on the browser terminal's stdin seam in `terminal-server.ts`. It replays a complete bracketed paste of text as keystrokes when the pane is Claude Code, and it queues later input behind the replay, so the Enter that a client sends 100 ms after its paste cannot overtake the text.
- A paste that holds only file paths stays a paste. Claude Code turns a pasted image path into an attachment and does not do that for a typed path.

## Consequences
- Typed delivery costs one tmux call for each chunk and each newline, where a paste cost one call. Measured: 68 steps in 1.26 s, about 18 ms a step. A 64 KB prompt of 80-character lines is about 1,600 steps, about 30 s.
- A paste into the browser terminal of a Claude Code tab also arrives as typed text. The operator's clipboard is treated as the operator's words. Text copied from an untrusted page loses the `<pasted_content>` marker that Claude Code would give it.
- The 200-character chunk and the 10 ms gap are measured against one Claude Code version. If a later version lowers the burst threshold, the wrapper returns; the transcript check in the table above is the test.
- A paste split across two websocket messages is not replayed and stays a paste.
