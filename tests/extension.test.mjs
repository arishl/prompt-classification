import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

if (process.env.PI_RUNTIME_ROOT) {
  const require = createRequire(resolve(process.env.PI_RUNTIME_ROOT, "package.json"));
  const tuiPath = require.resolve("@earendil-works/pi-tui");
  registerHooks({ resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === "@earendil-works/pi-tui" ? tuiPath : specifier, context);
  } });
}

const { default: extension, classifications } = await import("../index.ts");
const { classifyPrompt } = await import("../classify.ts");
const { collectPrompts, summarizeReviews } = await import("../session-review.ts");
const { parseAIReview, reviewWithAI } = await import("../ai-review.ts");
const { styleText, visibleWidth } = await import("@earendil-works/pi-tui");
const fixtures = JSON.parse(await readFile(new URL("./fixtures.json", import.meta.url), "utf8"));
const theme = {
  bold: (text) => text,
  style: (text, options) => styleText(text, options, "truecolor"),
  fg: (_token, text) => text,
};
const history = (id, role, content, timestamp = 1) => ({ id, type: "message", message: { role, content, timestamp } });
const input = (text = "Explain `index.ts` briefly") => ({ text, hasImages: false, context: [], promptTimestamp: 1 });
const response = (text = '{"classification":"Best","feedback":"Clear and sufficient for the task."}') => ({
  content: [{ type: "text", text }], stopReason: "stop", usage: { totalTokens: 30, cost: { total: 0.001 } },
});
const aiContext = (complete = async () => response()) => ({
  model: { id: "test", provider: "test" },
  modelRegistry: { hasConfiguredAuth: () => true, complete },
});

function harness(mode = "tui", branch = []) {
  const handlers = new Map();
  const commands = new Map();
  const renderers = new Map();
  const entries = [];
  const notifications = [];
  const statuses = [];
  const confirms = [];
  let accept = true;
  let idle = true;
  let sequence = 0;
  const ctx = {
    mode, hasUI: mode === "tui" || mode === "rpc", ...aiContext(),
    isIdle: () => idle,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (_key, text) => statuses.push(text),
      confirm: async (...args) => { confirms.push(args); return accept; },
    },
  };
  extension({
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerEntryRenderer(type, callback) { renderers.set(type, callback); },
    appendEntry(customType, data) {
      const entry = { id: `custom-${++sequence}`, type: "custom", customType, data };
      entries.push(entry); branch.push(entry);
    },
  });
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  return {
    entries, branch, ctx, notifications, statuses, confirms,
    ratings: () => entries.filter((entry) => entry.customType === "prompt-classification"),
    reports: () => entries.filter((entry) => entry.customType === "prompt-session-review"),
    render: (type, data, expanded = false) => renderers.get(type)({ data }, { expanded }, theme),
    command: (args) => commands.get("prompt-review").handler(args, ctx),
    emit,
    accept(value) { accept = value; },
    idle(value) { idle = value; },
    user(timestamp = 1, content = "Explain this plugin", persist = true) {
      const message = { role: "user", timestamp, content };
      if (persist) branch.push(history(`user-${++sequence}`, "user", content, timestamp));
      return emit("message_start", { message });
    },
  };
}

test("realistic benchmark: context, brevity, ambiguity, and all ten labels", () => {
  assert.deepEqual(new Set(fixtures.map((item) => item.expected)), new Set(classifications.map(({ name }) => name)));
  for (const fixture of fixtures) {
    const review = classifyPrompt(fixture.text, fixture.hasImages, fixture.context);
    assert.equal(review.classification, fixture.expected, fixture.text);
    assert.ok(review.feedback.split(/\s+/).length <= 12, review.feedback);
    assert.deepEqual(classifyPrompt(fixture.text, fixture.hasImages, fixture.context), review);
  }
  assert.equal(classifyPrompt("background information ".repeat(100)).classification, "Miss");
});

test("contradiction checks avoid alternatives, repeated formats, and quoted examples", () => {
  for (const text of [
    "Return only JSON and return only JSON", "Compare JSON and XML", "Return JSON or XML",
    'Explain "return only JSON and return only XML"',
    "Explain ```return only JSON and return only XML```",
  ]) assert.notEqual(classifyPrompt(text).classification, "Blunder", text);
});

test("collects only active-branch users, with preceding visible context and pre-compaction history", () => {
  const branch = [
    history("u1", "user", "Explain this plugin"),
    history("a1", "assistant", [{ type: "thinking", thinking: "private" }, { type: "toolCall", name: "read" }, { type: "text", text: "The bug is in `index.ts`." }]),
    history("t1", "toolResult", "tool output"),
    { id: "compact", type: "compaction", summary: "summary" },
    { id: "review", type: "custom", customType: "prompt-classification", data: {} },
    { id: "injected", type: "custom_message", content: "not user input" },
    history("u2", "user", [{ type: "text", text: "fix it" }, { type: "image", data: "IMAGE_BYTES" }], 2),
  ];
  const prompts = collectPrompts(branch);
  assert.deepEqual(prompts.map((item) => item.promptId), ["u1", "u2"]);
  assert.equal(prompts[0].context.length, 0);
  assert.equal(prompts[1].hasImages, true);
  assert.equal(classifyPrompt(prompts[1].text, true, prompts[1].context).classification, "Good");
  assert.ok(!JSON.stringify(prompts).includes("private"));
  assert.ok(!JSON.stringify(prompts).includes("IMAGE_BYTES"));
});

test("score is a rounded label mean and excludes Book; empty/greeting sessions are unscored", () => {
  const reviews = ["Best", "Inaccuracy", "Book"].map((classification) => ({ classification, feedback: "Be specific.", source: "local" }));
  const summary = summarizeReviews(reviews);
  assert.equal(summary.score, 73); // (90 + 55) / 2 rounded
  assert.equal(summary.total, 3);
  assert.equal(summary.scored, 2);
  assert.match(summary.takeaways.join(" "), /Be specific/);
  assert.equal(summarizeReviews([]).score, null);
  assert.equal(summarizeReviews([reviews[2]]).score, null);
});

test("automatic ratings wait for final settle and appear once per delivered prompt", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("agent_settled", { aborted: false });
  h.user(10);
  await h.emit("agent_end");
  await h.emit("turn_end");
  assert.equal(h.ratings().length, 0);
  h.user(20);
  await h.emit("agent_settled", { aborted: false });
  assert.deepEqual(h.ratings().map((entry) => entry.data.promptTimestamp), [10, 20]);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.ratings().length, 2);
});

test("automatic reviews use prior context whether the current message is persisted yet or not", async () => {
  for (const persist of [true, false]) {
    const h = harness("tui", [history("u", "user", "Explain this plugin"), history("a", "assistant", "The bug is in `index.ts`.")]);
    h.user(5, "fix it", persist);
    await h.emit("agent_settled", { aborted: false });
    assert.equal(h.ratings()[0].data.classification, "Good");
  }
});

test("image-only messages and text blocks receive feedback without copying prompt text", async () => {
  const h = harness();
  h.user(1, [{ type: "text", text: "Explain `index.ts` briefly" }]);
  h.user(2, [{ type: "image", data: "unused", mimeType: "image/png" }]);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.ratings()[0].data.classification, "Excellent");
  assert.match(h.ratings()[1].data.feedback, /image/);
  assert.ok(!JSON.stringify(h.entries).includes("index.ts"));
});

test("aborted/error runs are not rated, but successful retries are", async () => {
  const h = harness();
  h.user(); await h.emit("agent_settled", { aborted: true });
  h.user(); h.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.ratings().length, 0);
  h.user();
  h.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
  h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.ratings().length, 1);
});

test("on/off, compact, and reviewer mode persist across reload and branch navigation", async () => {
  const h = harness();
  await h.command("off"); await h.command("compact");
  await h.emit("session_start");
  h.user(); await h.emit("agent_settled", { aborted: false });
  assert.equal(h.ratings().length, 0);
  assert.equal(h.render("prompt-classification", { classification: "Good", feedback: "Clear.", source: "local" }).render(100).length, 1);
  await h.command("on");
  await h.command("mode ai");
  assert.equal(h.confirms.length, 1);
  await h.emit("session_start");
  await h.command("status");
  assert.match(h.notifications.at(-1).message, /on · ai · compact/);
  h.branch.splice(0);
  await h.emit("session_tree");
  await h.command("status");
  assert.match(h.notifications.at(-1).message, /on · local · expanded/);
});

test("declining AI opt-in leaves local mode enabled", async () => {
  const h = harness(); h.accept(false);
  await h.command("mode ai");
  await h.command("status");
  assert.match(h.notifications.at(-1).message, /local/);
});

test("full review re-evaluates all historical prompts, even with automatic badges off", async () => {
  const h = harness("tui", [history("1", "user", "hi"), history("2", "user", "What's the capital of France?"), { id: "c", type: "compaction" }, history("3", "user", "fix it")]);
  await h.command("off");
  await h.command("full");
  const report = h.reports()[0].data;
  assert.equal(report.total, 3);
  assert.equal(report.scored, 2);
  assert.equal(report.score, 73);
  assert.deepEqual(report.reviews.map((item) => item.promptId), ["1", "2", "3"]);
  const rendered = h.render("prompt-session-review", report).render(100).join("\n");
  assert.match(rendered, /73\/100/);
  assert.match(rendered, /3\. .*Inaccuracy/);
  assert.ok(!JSON.stringify(report).includes("capital of France"));
});

test("full review refuses busy sessions and handles empty sessions without a bogus score", async () => {
  const h = harness();
  await h.command("full"); assert.equal(h.reports().length, 0);
  assert.match(h.notifications.at(-1).message, /No user prompts/);
  h.idle(false); h.user(); await h.command("full");
  assert.equal(h.reports().length, 0);
  assert.match(h.notifications.at(-1).message, /Wait/);
});

test("AI parsing validates labels, shortens feedback, and strips terminal controls", () => {
  assert.throws(() => parseAIReview('{"classification":"Amazing","feedback":"hello"}'));
  assert.throws(() => parseAIReview('{"classification":"Good","feedback":""}'));
  assert.throws(() => parseAIReview("not JSON"));
  const review = parseAIReview('```json\n{"classification":"Best","feedback":"\\u001b[31mClear request. One two three four five six seven eight nine ten eleven twelve thirteen"}\n```');
  assert.equal(review.classification, "Best");
  assert.ok(!review.feedback.includes("\x1b"));
  assert.ok(review.feedback.split(/\s+/).length <= 12);
});

test("AI review sends bounded data with no tools/image bytes and records usage", async () => {
  let request;
  const ctx = aiContext(async (...args) => { request = args; return response(); });
  const result = await reviewWithAI({ ...input("x".repeat(8000)), hasImages: true, context: [{ role: "assistant", text: "y".repeat(8000) }] }, ctx, new AbortController().signal);
  assert.equal(result.source, "ai");
  assert.equal(result.inputTruncated, true);
  assert.deepEqual(result.usage, { tokens: 30, cost: 0.001 });
  const data = JSON.parse(request[1].messages[0].content[0].text);
  assert.equal(data.currentPrompt.length, 6000);
  assert.equal(data.priorContext[0].text.length, 1500);
  assert.equal(request[1].tools, undefined);
  assert.match(request[1].systemPrompt, /untrusted/);
});

test("AI failures, malformed responses, absent auth, and timeouts use labeled local feedback", async () => {
  for (const ctx of [
    aiContext(async () => { throw new Error("provider error"); }),
    aiContext(async () => response("invalid")),
    aiContext(async () => ({ ...response(), stopReason: "error" })),
    { model: undefined, modelRegistry: {} },
    { model: {}, modelRegistry: { hasConfiguredAuth: () => false } },
    { model: {}, modelRegistry: { hasConfiguredAuth: () => { throw new Error("Auth unavailable"); } } },
  ]) {
    const result = await reviewWithAI(input(), ctx, new AbortController().signal);
    assert.equal(result.source, "local-fallback");
    assert.equal(result.classification, "Excellent");
    assert.ok(result.fallbackReason);
  }
  const timed = await reviewWithAI(input(), aiContext(() => new Promise(() => {})), new AbortController().signal, 5);
  assert.match(timed.fallbackReason, /timed out/);
  await assert.rejects(reviewWithAI(input(), aiContext(), AbortSignal.abort()));
});

test("full AI review confirms cost, calls once per prompt, and reports mixed fallback sources", async () => {
  const h = harness("tui", [history("1", "user", "hi"), history("2", "user", "Explain this plugin")]);
  let calls = 0;
  h.ctx.modelRegistry.complete = async () => ++calls === 1 ? response('{"classification":"Book","feedback":"Natural greeting."}') : response("bad JSON");
  await h.command("full ai");
  assert.equal(calls, 2);
  assert.match(h.confirms[0][1], /2 additional paid calls/);
  const report = h.reports()[0].data;
  assert.deepEqual(report.reviews.map((item) => item.source), ["ai", "local-fallback"]);
  assert.equal(report.scored, 1);
  assert.equal(report.score, 75);
});

test("full reviews never use a prompt's own answer as its prior context", async () => {
  const h = harness("tui", [
    history("1", "user", "What's the capital of Georgia?"),
    history("2", "assistant", "For the country, it is Tbilisi."),
    history("3", "user", "What's the capital of Georgia?", 3),
  ]);
  await h.command("full local");
  assert.deepEqual(h.reports()[0].data.reviews.map((item) => item.classification), ["Inaccuracy", "Best"]);
});

test("declined full AI review makes no calls", async () => {
  const h = harness("tui", [history("1", "user", "hi")]);
  h.accept(false);
  h.ctx.modelRegistry.complete = async () => { assert.fail("Should not call AI"); };
  await h.command("full ai"); assert.equal(h.reports().length, 0);
});

test("slow reviews cannot append stale entries after cancellation, shutdown, new input, or branch changes", async () => {
  for (const action of ["cancel", "off", "session_shutdown", "session_tree", "new-user", "input", "agent_start"]) {
    const h = harness("tui", [history("1", "user", "Explain this plugin")]);
    let started;
    const began = new Promise((resolve) => { started = resolve; });
    h.ctx.modelRegistry.complete = () => { started(); return new Promise(() => {}); };
    const task = h.command("full ai");
    await began;
    if (action === "cancel" || action === "off") await h.command(action);
    else if (action === "new-user") h.user(2);
    else await h.emit(action);
    await task;
    assert.equal(h.reports().length, 0, action);
    assert.equal(h.statuses.at(-1), undefined);
  }
});

test("automatic AI reviews are opt-in and cancelled work never creates stale badges", async () => {
  const h = harness();
  await h.command("mode ai");
  h.user();
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.ratings()[0].data.source, "ai");
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  h.ctx.modelRegistry.complete = () => { started(); return new Promise(() => {}); };
  h.user(2);
  const task = h.emit("agent_settled", { aborted: false });
  await began; await h.command("cancel"); await task;
  assert.equal(h.ratings().length, 1);
});

test("noninteractive modes do not append reviews or enable AI", async () => {
  for (const mode of ["rpc", "print", "json"]) {
    const h = harness(mode);
    h.user(); await h.emit("agent_settled", { aborted: false });
    await h.command("full ai"); await h.command("mode ai");
    assert.equal(h.entries.length, 0);
    assert.equal(h.confirms.length, 0);
  }
});

test("all badges, legacy entries, compact mode, and full reports render within narrow widths", async () => {
  const h = harness();
  for (const badge of classifications) {
    const component = h.render("prompt-classification", { classification: badge.name, feedback: "Clear target and boundaries.", source: "local" });
    const wide = component.render(100).join("\n");
    assert.ok(wide.includes(badge.symbol)); assert.ok(wide.includes(badge.name));
    assert.ok(wide.includes("Local review")); assert.ok(wide.includes("\x1b[48;2;"));
    for (const width of [1, 10, 30, 80]) {
      component.invalidate();
      assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    }
  }
  const legacy = h.render("prompt-classification", { classification: "Good" });
  assert.match(legacy.render(100).join("\n"), /Legacy/);
  await h.command("compact");
  const badge = h.render("prompt-classification", { classification: "Good", source: "local", feedback: "Clear." });
  assert.equal(badge.render(100).length, 1);
  const report = summarizeReviews([{ classification: "Good", source: "local", feedback: "Add an example.", promptTimestamp: 1 }]);
  for (const width of [1, 10, 30, 80]) {
    assert.ok(h.render("prompt-session-review", report).render(width).every((line) => visibleWidth(line) <= width));
  }
});
