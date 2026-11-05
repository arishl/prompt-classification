export interface PromptReview {
  classification: string;
  feedback: string;
}

/** Local writing heuristics, not a semantic/model-based quality judgment. */
export function classifyPrompt(text: string, hasImages = false): PromptReview {
  const prompt = text.trim();
  const words = prompt.split(/\s+/).filter(Boolean);
  const result = (classification: string, feedback: string) => ({ classification, feedback });

  if (!prompt) {
    return hasImages
      ? result("Inaccuracy", "Image attached; say what you want checked.")
      : result("Miss", "Add a question or task to get started.");
  }

  if (/^(hi|hey|hello|thanks|thank you|yo|what['’]?s up)[!.?\s]*$/i.test(prompt)) {
    return result("Book", "Natural conversational opener; no extra detail needed.");
  }
  if (/^(yes|no|sure|ok|okay|go ahead|continue|do it)[!.\s]*$/i.test(prompt)) {
    return result("Good", "Concise follow-up; its meaning depends on the previous turn.");
  }
  if (/^(fix|improve|change|explain|review|make|do|help)(\s+(it|this|that|better|me|please))*[!.?\s]*$/i.test(prompt)) {
    return result("Inaccuracy", "Name the target and the change you want.");
  }

  const action = /\b(add|build|change|check|classify|compare|convert|create|debug|describe|explain|find|fix|implement|include|list|make|refactor|remove|replace|review|show|summarize|test|update|write)\b/i.test(prompt);
  const question = /\?|\b(what|why|how|when|where|which|who)\b/i.test(prompt);
  const concrete = hasImages || /`[^`]+`|\b[\w-]+\.(ts|tsx|js|jsx|rs|cpp|h|py|json|md)\b|(?:~\/|\.\/|https?:\/)|\b(error|expected|actual|plugin|function|endpoint|component|prompt|badge|classification)\b/i.test(prompt);
  const constraints = /\b(without|avoid|only|must|keep|brief|briefly|concise|under|at most|no more than|do not|don't|instead|after|before)\b/i.test(prompt);
  const evidence = /```[\s\S]+?```|\b(reproduce|reproduction|stack trace|currently|actual|expected|for example|e\.g\.)\b/i.test(prompt);
  const verification = /\b(test(s|ing)?|verify|assert|acceptance|should return|should display|must return|must display)\b/i.test(prompt);

  // Two exclusive output formats make the requested result impossible to satisfy.
  const exclusiveFormats = [...prompt.matchAll(/\b(?:return|output|respond with) only (?:valid )?(json|xml|yaml|plain text)\b/gi)]
    .map((match) => match[1].toLowerCase());
  if (new Set(exclusiveFormats).size > 1) {
    return result("Blunder", "Incompatible exclusive output formats; pick one.");
  }

  // Explicit contradictory length instructions are actionable even without context.
  if (/\b(exactly|only) one (word|sentence)\b/i.test(prompt) && /\b(at least|minimum of) (two|three|[2-9]) (words|sentences)\b/i.test(prompt)) {
    return result("Mistake", "Conflicting length limits; choose one output requirement.");
  }
  if (!action && !question) {
    return concrete
      ? result("Miss", "Useful context, but no task; say what you want checked or changed.")
      : result("Inaccuracy", "State what you want done with this information.");
  }
  if (words.length <= 12 && question) {
    return result("Good", "Direct question; short is fine when the topic is clear.");
  }
  if (concrete && constraints && evidence && verification) {
    if (/```[\s\S]+?```|\b(reproduce|reproduction|steps to reproduce)\b/i.test(prompt)) {
      return result("Brilliant", "Reproducible example, clear boundaries, and a way to verify the fix.");
    }
    return result("Best", "Clear target, boundaries, supporting context, and a success check.");
  }
  if (concrete && constraints && (evidence || verification)) {
    return result("Great", "Clear target and constraints, with useful validation context.");
  }
  if (concrete && constraints) {
    return result("Excellent", "Clear target and boundaries; easy to act on.");
  }
  if (concrete) {
    return result("Good", "Specific target; add the desired outcome or a constraint.");
  }
  if (words.length < 5 && !question) {
    return result("Inaccuracy", "Add the target or the outcome you want.");
  }
  return result("Good", "Recognizable request; an example would make it more precise.");
}
