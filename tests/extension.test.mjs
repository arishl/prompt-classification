import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

// Use Pi's bundled peers without installing a second copy. Alternatively,
// npm-installed peers resolve normally when PI_RUNTIME_ROOT is not supplied.
if (process.env.PI_RUNTIME_ROOT) {
  const require = createRequire(resolve(process.env.PI_RUNTIME_ROOT, "package.json"));
  const tuiPath = require.resolve("@earendil-works/pi-tui");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@earendil-works/pi-tui") {
        return nextResolve(tuiPath, context);
      }
      return nextResolve(specifier, context);
    },
  });
}

const { default: extension, classifications } = await import("../index.ts");
const { classifyPrompt } = await import("../classify.ts");
const { styleText, visibleWidth } = await import("@earendil-works/pi-tui");

function harness(mode = "tui") {
  const handlers = new Map();
  const entries = [];
  let renderer;
  extension({
    on(name, handler) { handlers.set(name, handler); },
    registerEntryRenderer(_type, callback) { renderer = callback; },
    appendEntry(customType, data) { entries.push({ customType, data }); },
  });
  return {
    entries,
    render: (...args) => renderer(...args),
    emit(name, event = {}) { handlers.get(name)?.(event, { mode }); },
    user(timestamp = 1, content = "Explain this plugin") {
      handlers.get("message_start")({ message: { role: "user", timestamp, content } }, { mode });
    },
  };
}

test("reviews reflect prompt features, not randomness or length alone", () => {
  const cases = [
    ["hi", "Book"],
    ["continue", "Good"],
    ["fix it", "Inaccuracy"],
    ["Why is the sky blue?", "Good"],
    ["Explain `index.ts` briefly", "Excellent"],
    ["Fix `index.ts` without new dependencies; add tests", "Great"],
    ["Fix `index.ts` without dependencies. Actual: crash. Expected: no crash. Add tests.", "Best"],
    ["Fix `index.ts` without dependencies. Steps to reproduce: open an empty file. Expected: no crash. Add tests.", "Brilliant"],
    ["Return only JSON and return only XML", "Blunder"],
    ["Error in `index.ts`: unexpected token", "Miss"],
    ["Write exactly one sentence and at least three sentences", "Mistake"],
    ["", "Miss"],
    ["background information ".repeat(50), "Inaccuracy"],
  ];
  // Every advertised badge must be obtainable, not just present in the renderer.
  assert.deepEqual(
    new Set(cases.map(([, expected]) => expected)),
    new Set(classifications.map(({ name }) => name)),
  );
  for (const [prompt, expected] of cases) {
    const review = classifyPrompt(prompt);
    assert.equal(review.classification, expected, prompt);
    assert.ok(review.feedback.length < 100);
    assert.deepEqual(classifyPrompt(prompt), review);
  }
  assert.match(classifyPrompt("", true).feedback, /Image attached/);
});

test("exclusive-format conflict requires distinct, explicitly exclusive formats", () => {
  for (const prompt of [
    "Return only JSON and return only JSON",
    "Compare JSON and XML",
    "Return JSON or XML",
  ]) {
    assert.notEqual(classifyPrompt(prompt).classification, "Blunder");
  }
  assert.equal(classifyPrompt("Output only valid JSON; respond with only YAML").classification, "Blunder");
});

test("delivered text blocks produce stored feedback without duplicating prompt text", () => {
  const h = harness();
  h.user(1, [{ type: "text", text: "Explain `index.ts` briefly" }]);
  h.user(2, [{ type: "image", data: "unused", mimeType: "image/png" }]);
  h.emit("agent_settled", { aborted: false });
  assert.equal(h.entries[0].data.classification, "Excellent");
  assert.match(h.entries[0].data.feedback, /Clear target/);
  assert.match(h.entries[1].data.feedback, /Image attached/);
  assert.ok(!JSON.stringify(h.entries).includes("index.ts"));
});

test("ratings appear only at final settle, once per delivered prompt", () => {
  const h = harness();
  h.emit("session_start");
  h.emit("agent_settled", { aborted: false });
  assert.equal(h.entries.length, 0);
  h.user(10);
  h.emit("agent_end");
  h.emit("turn_end");
  assert.equal(h.entries.length, 0);
  h.user(20); // Delivered steering/follow-up prompt in the same busy cycle.
  h.emit("agent_settled", { aborted: false });
  assert.deepEqual(h.entries.map((e) => e.data.promptTimestamp), [10, 20]);
  h.emit("agent_settled", { aborted: false });
  assert.equal(h.entries.length, 2);
});

test("aborted and failed runs do not leave stale ratings", () => {
  const h = harness();
  h.user();
  h.emit("agent_settled", { aborted: true });
  h.user();
  h.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
  h.emit("agent_settled", { aborted: false });
  assert.equal(h.entries.length, 0);
  h.user(3);
  h.emit("agent_settled", { aborted: false });
  assert.equal(h.entries.length, 1);
});

test("successful retry is rated and session replacement clears pending work", () => {
  const h = harness();
  h.user();
  h.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
  h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
  h.emit("agent_settled", { aborted: false });
  assert.equal(h.entries.length, 1);
  h.user();
  h.emit("session_shutdown");
  h.emit("session_start");
  h.emit("agent_settled", { aborted: false });
  assert.equal(h.entries.length, 1);
});

test("noninteractive modes do not append review entries", () => {
  for (const mode of ["rpc", "print", "json"]) {
    const h = harness(mode);
    h.user();
    h.emit("agent_settled", { aborted: false });
    assert.equal(h.entries.length, 0);
  }
});

test("all badges render colors, symbols, and brief feedback at narrow widths", () => {
  const h = harness();
  const theme = {
    style: (text, options) => styleText(text, options, "truecolor"),
    fg: (_token, text) => text,
  };
  for (const rating of classifications) {
    const component = h.render({ data: { classification: rating.name, feedback: "Clear target and boundaries." } }, {}, theme);
    const wide = component.render(100).join("\n");
    assert.ok(wide.includes(rating.symbol));
    assert.ok(wide.includes(rating.name));
    assert.ok(wide.includes("Clear target and boundaries."));
    assert.ok(!wide.includes("Random demo rating"));
    assert.ok(wide.includes("\x1b[48;2;"));
    for (const width of [1, 10, 30, 80]) {
      component.invalidate();
      assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    }
  }
});
