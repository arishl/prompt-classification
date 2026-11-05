import { classifications, type ContextMessage, type PromptReview } from "./classify.ts";

export type ReviewSource = "local" | "ai" | "local-fallback";
export interface ReviewedPrompt extends PromptReview {
  source: ReviewSource;
  promptTimestamp: number;
  promptId?: string;
  fallbackReason?: string;
  inputTruncated?: boolean;
  usage?: { tokens: number; cost: number };
}
export interface PromptInput {
  text: string;
  hasImages: boolean;
  context: ContextMessage[];
  promptTimestamp: number;
  promptId?: string;
}

// A structural subset keeps helpers usable without loading Pi at runtime.
interface HistoryEntry {
  id: string;
  type: string;
  message?: { role: string; content?: unknown; timestamp?: number };
}

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}
export function hasImages(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => part?.type === "image");
}

/** Caller supplies getBranch(): all original prompts, including pre-compaction ones. */
export function collectPrompts(entries: readonly HistoryEntry[]): PromptInput[] {
  const prompts: PromptInput[] = [];
  const context: ContextMessage[] = [];
  for (const entry of entries) {
    const message = entry.message;
    if (entry.type !== "message" || !message || (message.role !== "user" && message.role !== "assistant")) continue;
    const text = textContent(message.content);
    if (message.role === "user") prompts.push({
      text, hasImages: hasImages(message.content), context: context.slice(-4),
      promptTimestamp: message.timestamp ?? 0, promptId: entry.id,
    });
    // No thinking blocks, tool results, or custom entries are sent to reviewers.
    if (text.trim()) context.push({ role: message.role, text: text.slice(-1500) });
    if (context.length > 4) context.shift();
  }
  return prompts;
}

export interface SessionReview {
  reviews: ReviewedPrompt[];
  total: number;
  scored: number;
  score: number | null;
  distribution: { name: string; count: number }[];
  takeaways: string[];
}

export function summarizeReviews(reviews: ReviewedPrompt[]): SessionReview {
  const scored = reviews.flatMap((review) => {
    const score = classifications.find((item) => item.name === review.classification)?.score;
    return score == null ? [] : [{ review, score }];
  });
  const score = scored.length ? Math.round(scored.reduce((sum, item) => sum + item.score, 0) / scored.length) : null;
  const opportunities = [...scored].filter((item) => item.score < 85).sort((a, b) => a.score - b.score);
  const takeaways = [...new Set(opportunities.map(({ review }) => review.feedback))].slice(0, 2);
  if (!takeaways.length) takeaways.push(scored.length
    ? "Strong session: your requests generally supplied enough direction."
    : "No task prompts to score yet; greetings and acknowledgments are unscored.");
  const strong = scored.filter((item) => item.score >= 85).length;
  if (strong && opportunities.length) takeaways.unshift(`${strong} of ${scored.length} task prompts were clear and well specified.`);
  return {
    reviews, total: reviews.length, scored: scored.length, score,
    distribution: classifications.map(({ name }) => ({ name, count: reviews.filter((review) => review.classification === name).length }))
      .filter(({ count }) => count > 0),
    takeaways,
  };
}
