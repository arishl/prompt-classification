import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseColor, Text } from "@earendil-works/pi-tui";
import { classifyPrompt, type PromptReview } from "./classify.ts";

// Terminal-friendly recreations of the Game Review badges, not image assets.
export const classifications = [
  { name: "Brilliant", symbol: "!!", color: "#1baca6" },
  { name: "Great", symbol: "!", color: "#5c8bb0" },
  { name: "Best", symbol: "★", color: "#96bc4b" },
  { name: "Excellent", symbol: "✓", color: "#96bc4b" },
  { name: "Good", symbol: "✓", color: "#81b64c" },
  { name: "Book", symbol: "▤", color: "#a88865" },
  { name: "Inaccuracy", symbol: "?!", color: "#f7c631" },
  { name: "Mistake", symbol: "?", color: "#e6912c" },
  { name: "Miss", symbol: "✕", color: "#db6b5c" },
  { name: "Blunder", symbol: "??", color: "#ca3431" },
] as const;

interface Rating {
  classification: string;
  feedback?: string; // Older, random entries did not store feedback.
  promptTimestamp: number;
}

const entryType = "prompt-classification";

export default function promptClassification(pi: ExtensionAPI) {
  let pending: (PromptReview & { promptTimestamp: number })[] = [];
  let failed = false;

  pi.registerEntryRenderer<Rating>(entryType, (entry, _options, theme) => {
    const rating = classifications.find((item) => item.name === entry.data?.classification);
    if (!rating) return new Text("Prompt review: unknown classification", 0, 0);

    // Recompute styles whenever Pi rebuilds the renderer (including theme changes).
    const color = parseColor(rating.color);
    const badge = theme.style(` ${rating.symbol} `, {
      fg: parseColor("#ffffff"), bg: color, bold: true,
    });
    const label = theme.style(rating.name, { fg: color, bold: true });
    return new Text(
      `${badge} ${label} ${theme.fg("muted", "· Prompt review")}\n` +
      theme.fg("dim", entry.data?.feedback ?? "Legacy rating; submit a new prompt for feedback."),
      0, 0,
    );
  });

  // Observe delivered user messages, not input: commands and queued-but-not-yet-
  // delivered prompts should not get a rating. Only the derived review is stored.
  pi.on("message_start", (event, ctx) => {
    if (ctx.mode !== "tui" || event.message.role !== "user") return;
    const text = typeof event.message.content === "string"
      ? event.message.content
      : event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const hasImages = Array.isArray(event.message.content) &&
      event.message.content.some((part) => part.type === "image");
    pending.push({ ...classifyPrompt(text, hasImages), promptTimestamp: event.message.timestamp });
    failed = false;
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      failed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
    }
  });

  // agent_end can be followed by retries, tools, compaction, or queued work.
  // Only render once all automatic work has actually finished.
  pi.on("agent_settled", (event, ctx) => {
    const completed = pending;
    pending = [];
    if (ctx.mode !== "tui" || event.aborted || failed) return;
    for (const review of completed) {
      pi.appendEntry<Rating>(entryType, review);
    }
  });

  pi.on("session_start", () => { pending = []; failed = false; });
  pi.on("session_shutdown", () => { pending = []; failed = false; });
}
