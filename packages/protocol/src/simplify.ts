export const defaultSimplifyMaxWords = 100;
export const maximumSimplifyMaxWords = 2_000;
export const maximumSimplifyGuidanceLength = 600;

export interface SimplifySettings {
  readonly maxWords: number;
  readonly guidance?: string;
}

export interface ParsedSimplifyCommand {
  readonly active: boolean;
  readonly target: "previous" | "upcoming";
  readonly content: string;
}

const simplifyCommand = /(^|[\s([{:;,])\/simplify(?=$|\s|[,:;.!?](?:\s|$))[,:;.!?]?/giu;

export function normalizeSimplifySettings(value: unknown): SimplifySettings {
  const source = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const requested = typeof source.maxWords === "number" && Number.isFinite(source.maxWords)
    ? Math.trunc(source.maxWords)
    : defaultSimplifyMaxWords;
  const maxWords = Math.max(1, Math.min(maximumSimplifyMaxWords, requested));
  const guidance = typeof source.guidance === "string"
    ? source.guidance.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximumSimplifyGuidanceLength)
    : "";
  return { maxWords, ...(guidance ? { guidance } : {}) };
}

export function parseSimplifyCommand(value: string): ParsedSimplifyCommand {
  const source = value.trim();
  if (!simplifyCommand.test(source)) {
    simplifyCommand.lastIndex = 0;
    return { active: false, target: "upcoming", content: source };
  }
  simplifyCommand.lastIndex = 0;
  const content = source
    .replace(simplifyCommand, "$1")
    .replace(/[ \t]+([,.;!?])/gu, "$1")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/^\s*[,;:]\s*/u, "")
    .trim();
  simplifyCommand.lastIndex = 0;
  return content
    ? { active: true, target: "upcoming", content }
    : { active: true, target: "previous", content: "Simplify the previous answer." };
}

export function simplifyDeveloperInstructions(
  settings: SimplifySettings,
  target: ParsedSimplifyCommand["target"],
): string {
  const normalized = normalizeSimplifySettings(settings);
  const userGuidance = normalized.guidance
    ? ` User guidance: ${normalized.guidance.split(/\s+/u).slice(0, 80).join(" ")}`
    : "";
  const task = target === "previous"
    ? "Simplify the assistant's immediately previous answer."
    : "Answer the user's current request in a simplified form.";
  return `${task} Lead with the answer. Use calm, plain technical English. Explain unavoidable technical details clearly. Keep the complete response within ${normalized.maxWords} words. Preserve important qualifications and use your judgment about what can be shortened.${userGuidance}`;
}
