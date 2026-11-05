import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseColor, Text } from "@earendil-works/pi-tui";
import { classifyPrompt, classifications } from "./classify.ts";
import { reviewWithAI } from "./ai-review.ts";
import {
  collectPrompts, hasImages, summarizeReviews, textContent,
  type PromptInput, type ReviewedPrompt, type SessionReview,
} from "./session-review.ts";
export { classifications } from "./classify.ts";

const entryType = "prompt-classification";
const settingsType = "prompt-review-settings";
const reportType = "prompt-session-review";
type Mode = "local" | "ai";
interface Settings { enabled: boolean; mode: Mode; compact: boolean }
const defaults: Settings = { enabled: true, mode: "local", compact: false };
const sourceLabel = (source?: string) => source === "ai" ? "AI review" : source === "local-fallback" ? "Local fallback" : "Local review";

export default function promptClassification(pi: ExtensionAPI) {
  let settings = { ...defaults };
  let pending: PromptInput[] = [];
  let failed = false;
  let generation = 0;
  let active: AbortController | undefined;

  const cancel = (ctx: ExtensionContext) => {
    generation++;
    active?.abort();
    active = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(entryType, undefined);
  };
  const restore = (ctx: ExtensionContext) => {
    cancel(ctx);
    pending = [];
    failed = false;
    settings = { ...defaults };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== settingsType) continue;
      const data = entry.data as Partial<Settings> | undefined;
      if (data && typeof data.enabled === "boolean" && typeof data.compact === "boolean" &&
          (data.mode === "local" || data.mode === "ai")) {
        settings = { enabled: data.enabled, compact: data.compact, mode: data.mode };
      }
    }
  };
  const save = (ctx: ExtensionContext) => {
    cancel(ctx);
    pi.appendEntry(settingsType, { ...settings });
    ctx.ui.notify(`Prompt review ${settings.enabled ? "on" : "off"} · ${settings.mode} · ${settings.compact ? "compact" : "expanded"}`, "info");
  };

  // Stateless components pick up compact/expanded changes on the next render.
  pi.registerEntryRenderer<Partial<ReviewedPrompt>>(entryType, (entry, options, theme) => ({
    render(width) {
      const data = entry.data;
      const rating = classifications.find((item) => item.name === data?.classification);
      if (!rating) return new Text("Prompt review: unknown classification", 0, 0).render(width);
      const color = parseColor(rating.color);
      const badge = theme.style(` ${rating.symbol} `, { fg: parseColor("#ffffff"), bg: color, bold: true });
      const label = theme.style(rating.name, { fg: color, bold: true });
      const source = data?.source ? sourceLabel(data.source) : "Legacy review";
      const feedback = data?.feedback ?? "Legacy rating; submit a new prompt for feedback.";
      let text = `${badge} ${label} ${theme.fg("muted", `· ${source}`)}`;
      text += settings.compact && !options.expanded ? ` — ${feedback}` : `\n${theme.fg("dim", feedback)}`;
      if (options.expanded && data?.fallbackReason) text += `\n${theme.fg("dim", data.fallbackReason)}`;
      if (data?.inputTruncated) text += theme.fg("dim", " [prompt excerpt]");
      return new Text(text, 0, 0).render(width);
    },
    invalidate() {},
  }));

  pi.registerEntryRenderer<SessionReview>(reportType, (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return new Text("Session review unavailable", 0, 0);
    const local = data.reviews.filter((review) => review.source === "local").length;
    const ai = data.reviews.filter((review) => review.source === "ai").length;
    const fallback = data.reviews.length - ai - local;
    const usage = data.reviews.reduce((sum, review) => ({
      tokens: sum.tokens + (review.usage?.tokens ?? 0), cost: sum.cost + (review.usage?.cost ?? 0),
    }), { tokens: 0, cost: 0 });
    const lines = [
      theme.bold(`Full prompt review · ${data.score == null ? "Unscored" : `${data.score}/100`}`),
      `${data.total} prompts · ${data.scored} scored · ${data.total - data.scored} Book (unscored)`,
      `${local} local · ${ai} AI · ${fallback} local fallback`,
      theme.fg("dim", "Score = rounded mean of label points; Book excluded. Current branch only."),
      data.distribution.map((item) => `${item.name}: ${item.count}`).join(" · "),
      "",
      ...data.takeaways.map((tip) => `• ${tip}`),
      "",
      ...data.reviews.map((review, index) => {
        const badge = classifications.find((item) => item.name === review.classification)!;
        const label = theme.style(`${badge.symbol} ${badge.name}`, { fg: parseColor(badge.color), bold: true });
        return `${index + 1}. ${label} (${badge.score ?? "unscored"}) · ${sourceLabel(review.source)}\n   ${review.feedback}` +
          (review.inputTruncated ? " [prompt excerpt]" : "");
      }),
    ];
    if (usage.tokens) lines.push("", theme.fg("dim", `Recorded review usage: ${usage.tokens} tokens · $${usage.cost.toFixed(4)} (not included in Pi's session totals).`));
    return new Text(lines.join("\n"), 0, 0);
  });

  const review = async (input: PromptInput, mode: Mode, ctx: ExtensionContext, signal: AbortSignal): Promise<ReviewedPrompt> => {
    if (mode === "ai") return reviewWithAI(input, ctx, signal);
    return { ...classifyPrompt(input.text, input.hasImages, input.context), source: "local",
      promptId: input.promptId, promptTimestamp: input.promptTimestamp };
  };

  pi.on("message_start", (event, ctx) => {
    if (ctx.mode !== "tui" || event.message.role !== "user") return;
    // A newly delivered prompt invalidates any slow review of the previous run.
    cancel(ctx);
    failed = false;
    if (!settings.enabled) return;
    const branch = ctx.sessionManager.getBranch();
    const inputs = collectPrompts(branch);
    const delivered = inputs.at(-1);
    // The current message may or may not already be persisted at message_start.
    const current = delivered?.promptTimestamp === event.message.timestamp &&
      delivered.text === textContent(event.message.content) ? delivered : undefined;
    const contextEntries = current ? branch.slice(0, branch.findIndex((entry) => entry.id === current.promptId)) : branch;
    const context = contextEntries.flatMap((entry) => {
      if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
      const text = textContent(entry.message.content);
      return text.trim() ? [{ role: entry.message.role, text: text.slice(-1500) }] : [];
    }).slice(-4);
    pending.push({ text: textContent(event.message.content), hasImages: hasImages(event.message.content),
      context, promptTimestamp: event.message.timestamp, promptId: current?.promptId });
  });
  // Input can arrive while Pi is still awaiting settled handlers. Cancel early,
  // rather than making the next prompt wait for an unrelated AI review.
  pi.on("input", (_event, ctx) => { if (active) cancel(ctx); });
  pi.on("agent_start", (_event, ctx) => { if (active) cancel(ctx); });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") failed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
  });

  pi.on("agent_settled", async (event, ctx) => {
    const completed = pending;
    pending = [];
    if (ctx.mode !== "tui" || event.aborted || failed || !settings.enabled || !completed.length) return;
    const controller = new AbortController();
    active = controller;
    const version = generation;
    const mode = settings.mode;
    try {
      if (mode === "ai") ctx.ui.setStatus(entryType, "Reviewing prompt…");
      for (const input of completed) {
        const result = await review(input, mode, ctx, controller.signal);
        if (version !== generation || controller.signal.aborted) return;
        pi.appendEntry<ReviewedPrompt>(entryType, result);
      }
    } catch {
      // Lifecycle cancellation deliberately drops stale reviews.
    } finally {
      if (active === controller) {
        active = undefined;
        ctx.ui.setStatus(entryType, undefined);
      }
    }
  });

  pi.registerCommand("prompt-review", {
    description: "Prompt feedback: on/off, mode local|ai, compact/expanded, full [local|ai], cancel, status",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Prompt review requires interactive terminal mode.", "warning");
        return;
      }
      const command = args.trim().toLowerCase();
      if (!command || command === "status") {
        ctx.ui.notify(`Prompt review ${settings.enabled ? "on" : "off"} · ${settings.mode} · ${settings.compact ? "compact" : "expanded"}. Use /prompt-review full for a session score.`, "info");
      } else if (command === "cancel") {
        cancel(ctx);
        pending = [];
        ctx.ui.notify("Pending reviews cancelled.", "info");
      } else if (command === "on" || command === "off") {
        settings.enabled = command === "on";
        if (!settings.enabled) pending = [];
        save(ctx);
      } else if (command === "compact" || command === "expanded") {
        settings.compact = command === "compact";
        save(ctx);
      } else if (command === "mode local" || command === "mode ai") {
        const mode = command === "mode ai" ? "ai" : "local";
        const version = generation;
        if (mode === "ai" && settings.mode !== "ai") {
          const ok = await ctx.ui.confirm("Enable AI prompt reviews?", "Uses your selected Pi model. Each prompt adds a paid model call with the prompt and up to four recent user/assistant messages. No tools, thinking, or image bytes are sent. Continue?");
          if (!ok || version !== generation) return;
        }
        settings.mode = mode;
        save(ctx);
      } else if (/^full(?: (local|ai))?$/.test(command)) {
        if (!ctx.isIdle() || active) {
          ctx.ui.notify("Wait until Pi and any review finish, or use /prompt-review cancel.", "warning");
          return;
        }
        const inputs = collectPrompts(ctx.sessionManager.getBranch());
        if (!inputs.length) {
          ctx.ui.notify("No user prompts on this branch to review yet.", "info");
          return;
        }
        const mode: Mode = command.endsWith(" ai") ? "ai" : command.endsWith(" local") ? "local" : settings.mode;
        const controller = new AbortController();
        active = controller;
        const version = generation;
        try {
          if (mode === "ai") {
            const ok = await ctx.ui.confirm("Review the full session with AI?", `${inputs.length} prompts means up to ${inputs.length} additional paid calls using your selected model. Prompt text and bounded preceding conversation will be sent.`, { signal: controller.signal });
            if (!ok || controller.signal.aborted || version !== generation) return;
          }
          const reviews: ReviewedPrompt[] = [];
          for (const [index, input] of inputs.entries()) {
            if (controller.signal.aborted || version !== generation) return;
            ctx.ui.setStatus(entryType, `Session review ${index + 1}/${inputs.length}…`);
            reviews.push(await review(input, mode, ctx, controller.signal));
            // Let cancellation/input run even in a very long local-only session.
            if (index % 20 === 19) await new Promise((resolve) => setTimeout(resolve, 0));
          }
          if (controller.signal.aborted || version !== generation) return;
          pi.appendEntry<SessionReview>(reportType, summarizeReviews(reviews));
        } catch {
          if (!controller.signal.aborted) ctx.ui.notify("Session review could not finish. Try /prompt-review full local.", "warning");
        } finally {
          if (active === controller) {
            active = undefined;
            ctx.ui.setStatus(entryType, undefined);
          }
        }
      } else {
        ctx.ui.notify("Usage: /prompt-review on|off|mode local|mode ai|compact|expanded|full [local|ai]|cancel|status", "info");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => { cancel(ctx); pending = []; failed = false; });
}
