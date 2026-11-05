# Prompt Classification for Pi

Chess.com Game Review-inspired badges for your prompts. After Pi finishes responding, a colored badge appears in the transcript:

```text
 ✓  Excellent · Prompt review
Clear target and boundaries; easy to act on.
```

Ratings now use **local, deterministic writing heuristics** instead of randomness. Each badge comes with one brief observation or suggestion. Greetings get **Book**, vague requests like “fix it” get **Inaccuracy**, and requests with concrete targets, constraints, examples, and verification can earn **Great** or **Brilliant**. Concise questions are not penalized just for being short.

All ten classifications are active:

| Classification | Heuristic trigger |
| --- | --- |
| **Brilliant** `!!` | Target, constraints, context, verification, plus reproduction steps or a code example |
| **Great** `!` | Target and constraints, plus context or verification |
| **Best** `★` | Target, constraints, supporting context, and verification |
| **Excellent** `✓` | Concrete target and constraints |
| **Good** `✓` | Direct question, follow-up, or recognizable request |
| **Book** `▤` | Greeting or thanks |
| **Inaccuracy** `?!` | Vague target or unclear request |
| **Mistake** `?` | Conflicting length requirements |
| **Miss** `✕` | Context without a task, or empty input |
| **Blunder** `??` | Incompatible exclusive formats, e.g. “return only JSON and return only XML” |

This is a lightweight prompt-writing aid, not a model-based evaluation: it matches English words and patterns, cannot understand the full conversation, and may misclassify prompts (including quoted examples of conflicting instructions). Ratings are feedback, not safety gates.

The badges recreate the familiar symbols and approximate colors using terminal text and colored backgrounds (teal `!!`, blue `!`, green star/check, yellow `?!`, orange `?`, red `??`). They are not Chess.com's original image assets, and this extension is not affiliated with Chess.com. Book uses a terminal-friendly book symbol.

## Quick start

Requires [Pi](https://pi.dev) with the `@earendil-works` extension APIs (tested with Pi 1.5.0).

Clone this repository, then run from its root:

```sh
pi -e ./index.ts
```

Submit a prompt normally. The badge appears **after the full response finishes**, including tool calls, retries, and automatic continuations.

To keep it enabled across sessions, install the local package from the repository root:

```sh
pi install .
```

Then use `/reload` in Pi (or restart Pi). No npm install or extra runtime dependencies are needed; Pi supplies the TUI APIs. Merely opening this directory does not enable the extension.

## Behavior

- Interactive terminal mode only; no output or review entries in RPC, JSON, or print mode.
- One rating per delivered user message. If you queue follow-ups or steering messages, their ratings appear together after all work settles, in prompt order.
- Aborted runs and runs whose final assistant message is an error are not rated.
- Slash commands handled without an agent response are not rated.
- Ratings persist in the session and render again when it is resumed with the extension enabled.
- No model calls, network requests, or additional token costs. Prompt text is analyzed locally when delivered; only the derived classification, short feedback, and timestamp are stored in review entries (not a duplicate of the prompt).
- Historical random ratings keep their original badge and show a legacy note rather than invented feedback.
- Review entries are display-only and do not enter model context.

## Files

- `index.ts`: badge definitions, lifecycle hooks, transcript renderer.
- `classify.ts`: deterministic prompt classification and one-sentence feedback.
- `tests/extension.test.mjs`: lifecycle and rendering tests using Node's test runner and Pi's real TUI components.

## Tests

With the peer packages available locally (Node 22.18+):

```sh
npm install
npm test
```

Installing npm dependencies is only needed for standalone development, not for running the extension inside Pi.

Or use the packages bundled in your Pi installation, without installing dependencies:

```sh
PI_RUNTIME_ROOT="$HOME/.pi/agent/install/releases/1.5.0" npm test
```

`PI_RUNTIME_ROOT` is the directory containing Pi's `node_modules`; adjust it for your installed version. Tests require Node 22.18+ with TypeScript stripping and module hooks support.
