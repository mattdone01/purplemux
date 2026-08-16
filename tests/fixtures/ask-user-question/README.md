# Real AskUserQuestion pane captures

Captured 2026-08-16 from a live Claude Code session (`tmux -L purple capture-pane`) driving a
genuine two-question `AskUserQuestion`. **Not reconstructed** — every byte came off a running TUI.

The first attempt at story 31 was written against panes inferred from the binary's render code, and
those inferences were wrong in ways that would have shipped the same "stuck" bug. Keep these files
as the contract.

| file | state |
|---|---|
| `01-question1.txt` | initial render — question 1 of 2 |
| `02-after-right.txt` | after `Right` — question 2 (navigation is ←/→ or Tab, NOT automatic) |
| `03-after-right-again.txt` | after `Right` — the **Submit tab**, warning "You have not answered all questions" |
| `04-after-digit-2.txt` | after sending bare `2` on question 1 — selected AND auto-advanced, `☐ Colour` became `☒` |
| `05-after-last-answer.txt` | after answering the last question — parked on Submit with both answers listed |

## What these prove

1. A multi-question prompt is a **tabbed form**, not a sequence: `←  ☐ Colour  ☐ Size  ✔ Submit  →`.
2. A **bare digit selects and auto-advances**. The existing single-digit send is right about that.
3. The tab-bar checkbox is the live answered-state signal: `☐` unanswered, `☒` answered.
4. **After the last question the TUI parks on Submit and stays there.** Verified by waiting 8 s — it
   does not auto-submit. Answers are committed only by choosing `1. Submit answers`.
5. Option numbering includes synthetic trailing entries — `Type something.` and `Chat about this` —
   whose numbers **shift with the real option count** (4/5 on a 3-option question, 3/4 on a
   2-option one). A parser that assumes 1..N are the model's options will mis-map them.
6. Footer is `Enter to select · Tab/Arrow keys to navigate · Esc to cancel`.

## Second capture round (2026-08-16) — the four states the first rework asked for

Same method: a live agent, a real `AskUserQuestion`, `tmux capture-pane` at each step. Three
questions this time (`Colour`, `Sizes` with `multiSelect: true`, `Rollout` with deliberately long
text), which is the shape of the original report.

| file | state |
|---|---|
| `06-three-question-q1.txt` | three questions — the tab row fits on ONE line, no wrap, no truncation |
| `07-multiselect-q2.txt` | `multiSelect: true` — options render `[ ]` and a `Next` line appears under the last one |
| `08-wrapped-question-q3.txt` | a question that soft-wraps across two pane lines |
| `09-multiselect-after-digit.txt` | after sending `2` on the multiSelect |
| `10-after-escape.txt` | after `Escape` — the whole prompt is cancelled and the agent returns to idle |

### What these change

1. **Three headers fit one line:** `←  ☐ Colour  ☐ Sizes  ☐ Rollout  ✔ Submit  →`. No wrapping at 3.
   Untested beyond 3 — do not assume it never wraps, just that it does not here.
2. **multiSelect behaves differently from single-select and the difference is dangerous.** A digit
   **toggles** (`2. [✔] Medium`) and does **NOT** advance — the pane stays put. Single-select digits
   select *and* advance. Code that assumes "digit ⇒ advance" will hang on a multiSelect question.
3. **`☒` on a multiSelect means "at least one toggled", not "finished".** The tab flipped to
   `☒ Sizes` on the first toggle with two options still unchecked. Do not read `☒` as "this question
   is complete" for multiSelect.
4. **multiSelect offers `Next`** as a line under the final option — that is how it advances.
5. **Option descriptions render on the following line**, indented 5 spaces for single-select
   (`     Roll out to every workspace now.`) and 2 for multiSelect (`  Small`). A parser keying on
   indentation must handle both.
6. **Esc cancels the entire prompt**, not just the current question, and the agent goes idle.

## Third capture round (2026-08-16) — the tab row cannot wrap

| file | state |
|---|---|
| `11-four-questions-max.txt` | FOUR questions (the schema maximum) with 11–12 character headers |
| `12-submit-with-multiselect.txt` | the Submit tab of that prompt, with a multiSelect among the answers |

**The wrap question is closed, not merely unobserved.** `AskUserQuestion` caps `questions` at 4 and
`header` at 12 characters, so the widest possible row is

```
←  ☐ Configuratn  ☐ Environmnts  ☐ Deploymentz  ☐ Monitoringx  ✔ Submit  →
```

74 columns. `capturePaneAtWidth(session, 120, 50)` renders at 120 regardless of the human's actual
pane width, so the row has 46 columns of headroom in the worst case the schema permits. A
one-line-only tab parser is safe by construction, not by luck — but it is safe *because of the
schema cap*, so if that cap ever rises this assumption dies with it. Say so in the parser comment.

Also from `12`: a multiSelect answer renders in the Submit review exactly like a single-select one
(`● Env?` / `→ B`) when one option is toggled. Multiple toggles were not captured — out of scope
while the web UI refuses to drive multiSelect.
