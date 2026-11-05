// Terminal-friendly recreations of Game Review badges, not original image assets.
export const classifications = [
  { name: "Brilliant", symbol: "!!", color: "#1baca6", score: 100, meaning: "Especially effective framing or insight" },
  { name: "Great", symbol: "!", color: "#5c8bb0", score: 95, meaning: "Clear, actionable, and thoughtfully scoped" },
  { name: "Best", symbol: "★", color: "#96bc4b", score: 90, meaning: "Fully sufficient for the task; nothing important missing" },
  { name: "Excellent", symbol: "✓", color: "#96bc4b", score: 85, meaning: "Strong request with a minor opportunity to improve" },
  { name: "Good", symbol: "✓", color: "#81b64c", score: 75, meaning: "Understandable and workable" },
  { name: "Book", symbol: "▤", color: "#a88865", score: null, meaning: "Routine greeting or acknowledgment; unscored" },
  { name: "Inaccuracy", symbol: "?!", color: "#f7c631", score: 55, meaning: "Small ambiguity" },
  { name: "Mistake", symbol: "?", color: "#e6912c", score: 35, meaning: "Missing information likely to cause the wrong result" },
  { name: "Miss", symbol: "✕", color: "#db6b5c", score: 20, meaning: "Key question or objective omitted" },
  { name: "Blunder", symbol: "??", color: "#ca3431", score: 0, meaning: "Fundamentally conflicting requirements" },
] as const;

export type Classification = typeof classifications[number]["name"];
export interface PromptReview {
  classification: Classification;
  feedback: string;
}
export interface ContextMessage {
  role: "user" | "assistant";
  text: string;
}

export const rubric = classifications.map((item) => `${item.name}: ${item.meaning}`).join("\n");

/** Local writing heuristics, not a semantic/model-based quality judgment. */
export function classifyPrompt(text: string, hasImages = false, context: ContextMessage[] = []): PromptReview {
  const prompt = text.trim();
  const result = (classification: Classification, feedback: string): PromptReview => ({ classification, feedback });
  const recent = context.slice(-4).map((message) => message.text).join("\n");
  // Ignore quoted/code examples when checking for contradictory instructions.
  const instructions = prompt.replace(/```[\s\S]*?```|`[^`]*`|"[^"\n]*"|“[^”\n]*”/g, " ");

  if (!prompt) return hasImages
    ? result("Inaccuracy", "Say what you want checked in the image.")
    : result("Miss", "Add a question or task to get started.");

  if (/^(hi|hey|hello|thanks|thank you|yo|what['’]?s up)[!.?\s]*$/i.test(prompt)) {
    return result("Book", "Natural conversation; no extra detail needed.");
  }
  if (/^(yes|no|sure|ok|okay)[!.\s]*$/i.test(prompt)) {
    return result("Book", "Routine acknowledgment; no extra detail needed.");
  }
  if (/^(go ahead|continue|do it)[!.\s]*$/i.test(prompt)) {
    return recent.trim()
      ? result("Good", "Clear follow-up in this conversation.")
      : result("Inaccuracy", "Say what you want to continue or approve.");
  }

  const formats = [...instructions.matchAll(/\b(?:return|output|respond with) only (?:valid )?(json|xml|yaml|plain text)\b/gi)]
    .map((match) => match[1].toLowerCase());
  if (new Set(formats).size > 1) {
    return result("Blunder", "Choose one exclusive output format, not incompatible formats.");
  }
  if (/\b(exactly|only) one (word|sentence)\b/i.test(instructions) &&
      /\b(at least|minimum of) (two|three|[2-9]) (words|sentences)\b/i.test(instructions)) {
    return result("Blunder", "Choose one length requirement; these conflict.");
  }

  const vague = /^(fix|improve|change|explain|review|make|do|help)(\s+(it|this|that|better|me|please))*[!.?\s]*$/i.test(prompt);
  const contextualTarget = /`[^`]+`|\b[\w-]+\.(ts|tsx|js|jsx|rs|cpp|h|py|json|md)\b|\b(bug|plugin|function|endpoint|component|prompt|badge|classification|paragraph|essay)\b/i.test(recent);
  if (vague) return contextualTarget
    ? result("Good", "The preceding discussion supplies the target.")
    : result("Inaccuracy", "Name the target and the change you want.");

  if (/\bcapital of georgia\b/i.test(prompt) &&
      !/\b(country|state|u\.?s\.?|united states|tbilisi|atlanta)\b/i.test(prompt + "\n" + recent)) {
    return result("Inaccuracy", "Specify Georgia the country or the U.S. state.");
  }

  const action = /\b(add|build|change|check|classify|compare|convert|create|debug|define|delete|describe|explain|find|fix|implement|include|list|make|refactor|remove|replace|review|show|summarize|tell|test|translate|update|write)\b/i.test(instructions);
  const question = /\?|\b(what|why|how|when|where|which|who)\b/i.test(instructions);
  const concrete = hasImages || /`[^`]+`|\b[\w-]+\.(ts|tsx|js|jsx|rs|cpp|h|py|json|md)\b|(?:~\/|\.\/|https?:\/)|\b(error|plugin|function|endpoint|component|prompt|badge|classification)\b/i.test(prompt);
  // Require some content after signal words, rather than rewarding keywords alone.
  const constraints = /\b(without|avoid|only|must|keep|under|at most|do not|don't|instead|after|before)\s+\S+/i.test(instructions) || /\b(briefly|concise)\b/i.test(instructions);
  const evidence = /```[\s\S]+?```|\b(actual|expected|currently|for example)\s*:?\s+\S+/i.test(prompt);
  const verification = /\b(add|write|run)\s+(?:regression\s+)?tests?\b|\b(verify|assert|should return|should display|must return|must display)\s+\S+/i.test(instructions);
  const reproducible = /```[\s\S]+?```|\b(steps to reproduce|reproduction)\s*:\s*\S+/i.test(prompt);

  if (/\b(translate|summarize|rewrite)\s+(this|the following|the attached)\b/i.test(prompt) &&
      !hasImages && !recent.trim() && !/[:\n`]/.test(prompt)) {
    return result("Mistake", "Include the text you want transformed.");
  }
  if (!action && !question) return concrete
    ? result("Miss", "Context supplied; add the task you want performed.")
    : result("Miss", "State your question or objective.");

  // A complete, simple request need not be long or include coding constraints.
  if (!concrete && prompt.split(/\s+/).length <= 12 &&
      /^(?:please\s+)?(?:explain|define|describe|compare|tell me about)\s+(?!this\b|that\b|it\b|something\b|anything\b)\S+/i.test(prompt)) {
    return result("Best", "Clear topic; no elaborate instructions needed for this request.");
  }
  if (question && !action && prompt.split(/\s+/).length <= 18) {
    return result("Best", "Direct question with enough detail for a useful answer.");
  }
  if (concrete && constraints && evidence && verification) return reproducible
    ? result("Brilliant", "Reproducible example, clear scope, and a concrete success check.")
    : result("Great", "Clear scope, supporting context, and a way to verify success.");
  if (concrete && constraints && (evidence || verification)) {
    return result("Great", "Clear target and boundaries, with useful validation context.");
  }
  if (concrete && constraints) return result("Excellent", "Clear target and boundaries; a success check would help.");
  if (concrete || (contextualTarget && /\b(it|this|that)\b/i.test(prompt))) {
    return result("Good", "Workable request; specify what a successful result looks like.");
  }
  if (!question && prompt.split(/\s+/).length < 5) return result("Inaccuracy", "Add the target or the outcome you want.");
  return result("Good", "Understandable request; one concrete example would help.");
}
