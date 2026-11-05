# Prompt Classification for Pi

Chess.com Game Review-inspired feedback for your prompts, plus a full-session scorecard. Reviews appear **after Pi finishes responding**, including tool calls and automatic retries.

```text
 ?!  Inaccuracy · Local review
Specify Georgia the country or the U.S. state.
```

**Local by default. Context-aware. Optional AI review. No runtime dependencies beyond Pi.**

## Quick start

Requires [Pi](https://pi.dev) with the `@earendil-works` extension APIs (tested with Pi 1.5.0).

From this repository's root, try it for one session:

```sh
pi -e ./index.ts
```

Or install the local package persistently:

```sh
pi install .
```

Restart Pi or use `/reload` after installing/updating. Merely opening this directory does not enable the extension.

## Commands

| Command | Behavior |
| --- | --- |
| `/prompt-review` or `/prompt-review status` | Show current settings |
| `/prompt-review on` | Enable automatic feedback |
| `/prompt-review off` | Disable automatic feedback (manual full reviews still work) |
| `/prompt-review compact` | Put the badge and feedback on one logical line |
| `/prompt-review expanded` | Put feedback below the badge (default) |
| `/prompt-review mode local` | Free, deterministic local heuristics (default) |
| `/prompt-review mode ai` | Opt into model-based feedback, after confirmation |
| `/prompt-review full` | Review every prompt on the current branch using the selected mode |
| `/prompt-review full local` | Full review without model calls, regardless of selected mode |
| `/prompt-review full ai` | Full AI review, with a separate cost confirmation |
| `/prompt-review cancel` | Cancel any pending review |

Settings are saved **per session branch**, survive `/reload` and resume, and revert appropriately when you navigate the session tree. AI opt-in persists with those settings. Compact mode may wrap on narrow terminals. Expanding a badge reveals any AI fallback reason.

## How prompts are rated

The rubric rewards **clarity and sufficiency for the task**, not length, politeness, perfect spelling, or fancy formatting. All ten classifications are active:

| Classification | Points | Meaning |
| --- | ---: | --- |
| **Brilliant** `!!` | 100 | Especially effective framing or insight |
| **Great** `!` | 95 | Clear, actionable, and thoughtfully scoped |
| **Best** `★` | 90 | Fully sufficient for the task; nothing important missing |
| **Excellent** `✓` | 85 | Strong request with a minor opportunity to improve |
| **Good** `✓` | 75 | Understandable and workable |
| **Book** `▤` | — | Routine greeting or acknowledgment; unscored |
| **Inaccuracy** `?!` | 55 | Small ambiguity |
| **Mistake** `?` | 35 | Missing information likely to cause the wrong result |
| **Miss** `✕` | 20 | Key question or objective omitted |
| **Blunder** `??` | 0 | Fundamentally conflicting requirements |

Every review offers one short observation or smallest useful improvement, capped at 12 words for new reviews.

### Local mode

Local rules use the prompt plus up to four preceding user/assistant messages. For example:

- “hi” → **Book**; greetings do not lower your session score.
- “Why is the sky blue?” → **Best**; a concise question can be sufficient.
- “What's the capital of Georgia?” → **Inaccuracy**, unless the country/state is specified in the prompt or recent discussion.
- “fix it” → **Good** after discussing a concrete bug, otherwise **Inaccuracy**.
- “Translate this” with no source text or context → **Mistake**.
- Mutually exclusive JSON-only and XML-only instructions → **Blunder**.

This remains an **English pattern-based aid**, not semantic understanding. It can miss ambiguity, misread negation/quotes, or overvalue keywords. Coding-oriented patterns are more developed than other domains. AI mode uses the same rubric with richer interpretation, but its judgments can also be wrong or vary between calls.

### AI mode

AI reviews use **your currently selected Pi model**, through Pi's configured provider/authentication. Enabling it requires confirmation because each delivered prompt can add **one extra model call and token cost**. Full AI reviews separately confirm the maximum number of calls before starting.

- Only prompt text, an image-attachment indicator, and bounded preceding user/assistant text are sent.
- No tool output, thinking blocks, system instructions from your session, or image bytes are sent. The reviewer has no tools.
- Prior context is limited to four messages, at most 1,500 characters each. The current prompt is limited to 6,000 characters; truncated prompts are marked `[prompt excerpt]`. Local mode still examines the full current prompt.
- A 15-second deadline and 1,024 output-token cap bound each call. Provider billing may still apply to timed-out or cancelled requests.
- Invalid JSON, provider errors, or unavailable model/authentication fall back to local review, visibly labeled **Local fallback**.
- New prompts, new agent runs, session/branch changes, and `/prompt-review cancel` invalidate in-flight reviews so stale results are not appended.
- Completed-response usage is saved with review entries. Full reports show recorded review usage, but **these calls are not included in Pi's main session token/cost totals**. Usage for failed/cancelled calls may be unavailable.

AI mode sends conversation excerpts to the selected model's provider. Do not enable it for sensitive material unless that is appropriate for your provider and privacy requirements. Prompt-injection instructions in conversation data are treated as untrusted, but no model-based evaluator is infallible.

## Full-session review

Run this once Pi is idle:

```text
/prompt-review full
```

The scorecard includes:

- A **score out of 100** and classification distribution.
- Counts of reviewed/scored prompts and unscored Book messages.
- Brief takeaways highlighting strong requests and improvement opportunities.
- A numbered classification and brief feedback for **every user prompt** in the active branch, in conversation order.
- Source counts: local, AI, and local fallback.

**Formula:** the rounded arithmetic mean of the points in the table above, excluding Book. For example, Best (90), Inaccuracy (55), and Book yield **73/100**. Empty sessions and Book-only sessions are **unscored**, not 0/100.

This is a coaching score, not an objective measure of intelligence or model performance. It is recomputed from the original prompts and preceding context, not averaged from historical badge entries. This means it also covers prompts from before installation, prompts submitted with automatic feedback off, and aborted/failed task prompts.

“Full session” means **all user messages on the current branch**, including pre-compaction history retained in the session file. Abandoned branches, slash commands handled without a user message, tool results, and extension-authored custom messages are excluded. User-role messages inserted by other extensions cannot be distinguished from human prompts and are included. Each prompt is evaluated with preceding context, never later answers. Long sessions can take time; cancel to stop rather than publish a partial scorecard.

## Display and persistence

- Interactive terminal mode only; no review entries or model calls in RPC, print, or JSON modes.
- Automatic badges appear once per delivered user prompt after the agent fully settles. Queued follow-ups receive their badges together, in order.
- Aborted runs and runs ending in an assistant error do not receive automatic badges.
- Badges and scorecards are display-only custom entries; they do not enter model context or trigger more agent turns.
- Entries store derived feedback, source, prompt IDs/timestamps, and available usage—not duplicate prompt text. Original prompts already exist in Pi's session history. AI feedback may quote a small part of a prompt.
- Historical random/older ratings still render; no feedback is invented for them.

The symbols and approximate colors are terminal-friendly recreations, not Chess.com's original image assets. This project is not affiliated with Chess.com.

## Development

Files:

- `index.ts`: Pi lifecycle hooks, commands, settings, and transcript renderers.
- `classify.ts`: shared rubric, badge metadata, scoring points, and local evaluator.
- `ai-review.ts`: bounded model calls, JSON validation, sanitization, and local fallback.
- `session-review.ts`: branch prompt extraction and score aggregation.
- `tests/fixtures.json`: realistic prompt/context benchmark, covering all ten labels.
- `tests/extension.test.mjs`: benchmark, lifecycle, commands, scoring, mocked AI, cancellation, and real TUI rendering tests.

Tests require Node 22.18+ with TypeScript stripping and module hooks. With the peer packages installed locally:

```sh
npm install
npm test
```

Or use the dependencies already bundled in Pi without installing anything:

```sh
PI_RUNTIME_ROOT="$HOME/.pi/agent/install/releases/1.5.0" npm test
```

Adjust the release path for your Pi installation. Tests use mocked model responses, make no network calls, and incur no model charges. A real provider/interactive terminal smoke test remains useful before relying on AI mode.
