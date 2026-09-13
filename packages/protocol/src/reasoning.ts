const ambiguousEfforts = new Set(["", "auto", "default", "cli default", "session default"]);

export interface ReasoningEffortProfile {
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
}

export function extractAdvertisedReasoningEfforts(source: unknown): readonly string[] {
  if (source === undefined || source === null) return [];
  if (typeof source === "string") return concreteEffort(source);
  if (Array.isArray(source)) {
    return uniqueEfforts(source.flatMap((entry) => {
      const extracted = extractAdvertisedReasoningEfforts(entry);
      return extracted.length === 0 && entry !== null && typeof entry === "object" && typeof entry.id === "string"
        ? concreteEffort(entry.id) : extracted;
    }));
  }
  if (typeof source !== "object") return [];
  const record = source as Record<string, unknown>;
  // Harnesses such as OpenCode advertise reasoning levels as model variants
  // (variants: { high: …, max: … }); the variant names are the selectable
  // efforts and outrank a single stored default like options.reasoning_effort,
  // which would otherwise collapse the whole choice to one value.
  const variantNames = Object.keys(variantsContainer(record))
    .filter((name) => !ambiguousEfforts.has(name.trim().toLowerCase()));
  if (variantNames.length > 0) return uniqueEfforts(variantNames);
  const containers = [
    record.supportedReasoningEfforts,
    record.reasoningEfforts,
    record.supported_reasoning_efforts,
    record.thoughtLevels,
    record.thought_levels,
    record.thoughtLevelOptions,
    record.reasoning_effort_options,
    record.options,
  ];
  const nested = containers.flatMap((value) => (
    Array.isArray(value) || (value !== null && typeof value === "object")
      ? extractAdvertisedReasoningEfforts(value)
      : []
  ));
  if (nested.length > 0) return uniqueEfforts(nested);
  const optionValue = [
    record.reasoningEffort,
    record.reasoning_effort,
    record.thoughtLevel,
    record.thought_level,
    record.value,
  ].find((value): value is string => typeof value === "string");
  return optionValue === undefined ? [] : concreteEffort(optionValue);
}

/** Documented selectable efforts. Missing here means hide the control rather than invent one. */
export function knownReasoningProfile(
  providerId: string,
  modelId: string,
  displayName = "",
): ReasoningEffortProfile | undefined {
  const haystack = `${providerId} ${modelId} ${displayName}`.toLowerCase();
  if (/non-reasoning|non_reasoning/.test(haystack)) return undefined;
  if (/grok[- .]?4\.6/.test(haystack)) {
    return { efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" };
  }
  if (/grok[- .]?4\.5/.test(haystack)) {
    return { efforts: ["low", "medium", "high"], defaultEffort: "high" };
  }
  if (/grok[- .]?4\.3/.test(haystack)) {
    return { efforts: ["none", "low", "medium", "high"] };
  }
  return undefined;
}

export interface ReasoningLabelContext {
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly displayName?: string | undefined;
}

/** Compact human label. Codex `low` is Light; Grok's documented name is Low. */
/** Collapse provider spellings so Extra high, x-high, and xhigh stay one choice. */
export function canonicalizeReasoningEffort(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (normalized === "x-high" || normalized === "xhigh" || normalized === "extra-high" || normalized === "extrahigh") {
    return "xhigh";
  }
  if (normalized === "x-low" || normalized === "xlow") return "low";
  return normalized;
}

/** Return the advertised effort that matches a stored or requested value. */
export function matchReasoningEffort(value: string | undefined, advertised: readonly string[]): string | undefined {
  const concrete = value?.trim();
  if (!concrete || ambiguousEfforts.has(concrete.toLowerCase())) return undefined;
  const exact = advertised.find((entry) => entry === concrete);
  if (exact !== undefined) return exact;
  const key = canonicalizeReasoningEffort(concrete);
  return advertised.find((entry) => canonicalizeReasoningEffort(entry) === key);
}

export function reasoningDisplayLabel(value: string, context: ReasoningLabelContext = {}): string {
  const normalized = canonicalizeReasoningEffort(value);
  if (!normalized || ambiguousEfforts.has(value.trim().toLowerCase())) return "";
  if (normalized === "low") return usesCodexLightLabel(context) ? "Light" : "Low";
  if (normalized === "light") return "Light";
  if (normalized === "medium") return "Medium";
  if (normalized === "high") return "High";
  if (normalized === "minimal") return "Minimal";
  if (normalized === "max") return "Max";
  if (normalized === "ultra") return "Ultra";
  if (normalized === "xhigh") return "Extra high";
  if (normalized === "none" || normalized === "off") return "Off";
  return value;
}

function usesCodexLightLabel(context: ReasoningLabelContext): boolean {
  const haystack = `${context.providerId ?? ""} ${context.modelId ?? ""} ${context.displayName ?? ""}`.toLowerCase();
  if (haystack.includes("grok")) return false;
  if (context.providerId === "codex") return true;
  return /gpt[- .]?5\.6/.test(haystack);
}

export function resolveModelReasoningProfile(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly advertised?: unknown;
}): ReasoningEffortProfile {
  const advertised = extractAdvertisedReasoningEfforts(input.advertised);
  if (advertised.length > 0) {
    const known = knownReasoningProfile(input.providerId, input.modelId, input.displayName);
    const metadata = input.advertised !== null && typeof input.advertised === "object" && !Array.isArray(input.advertised)
      ? input.advertised as Record<string, unknown> : {};
    const nativeDefault = [metadata.defaultReasoningEffort, metadata.default_reasoning_effort]
      .find((value): value is string => typeof value === "string");
    const defaultEffort = matchReasoningEffort(nativeDefault, advertised) ?? matchReasoningEffort(known?.defaultEffort, advertised);
    return { efforts: advertised, ...(defaultEffort ? { defaultEffort } : {}) };
  }
  return knownReasoningProfile(input.providerId, input.modelId, input.displayName) ?? { efforts: [] };
}

const reasoningTypePattern = /thought|thinking|reason/iu;

/** Live payloads that should render as a running reasoning row, not final answer text. */
export function payloadLooksLikeReasoning(source: unknown, depth = 0): boolean {
  if (depth > 4 || source === undefined || source === null || typeof source !== "object") return false;
  const record = source as Record<string, unknown>;
  const partType = typeof record.partType === "string" ? record.partType.toLowerCase() : "";
  if (partType === "reasoning" || partType === "thought" || partType === "thinking") return true;
  if (typeof record.reasoning === "string" && record.reasoning.trim().length > 0) return true;
  if (record.thought === true || record.isThought === true || record.isThinking === true) return true;
  for (const key of ["thought", "thinking"] as const) {
    if (typeof record[key] === "string" && record[key].length > 0) return true;
  }
  for (const key of ["sessionUpdate", "session_update", "type"] as const) {
    if (typeof record[key] === "string" && reasoningTypePattern.test(record[key])) return true;
  }
  if (record.reasoning !== null && typeof record.reasoning === "object" && Object.keys(record.reasoning).length > 0) {
    return true;
  }
  return payloadLooksLikeReasoning(record.content, depth + 1) || payloadLooksLikeReasoning(record.part, depth + 1);
}

function concreteEffort(value: string): readonly string[] {
  const normalized = value.trim();
  return normalized && !ambiguousEfforts.has(normalized.toLowerCase()) ? [normalized] : [];
}

function variantsContainer(record: Record<string, unknown>): Record<string, unknown> {
  const value = record.variants;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function uniqueEfforts(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
