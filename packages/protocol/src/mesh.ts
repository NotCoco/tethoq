import type { DelegationPresentationSegment, DelegationTarget } from "./models.js";

/** The provider text for validated inline Mesh references, shared with echo matching. */
export function meshParentPrompt(targets: readonly DelegationTarget[], segments: readonly DelegationPresentationSegment[]): string {
  return segments.map((segment) => {
    if (segment.type === "text") return segment.text;
    const target = targets[segment.targetIndex]!;
    return `[Mesh target ${segment.targetIndex}: ${[target.providerId, target.modelId, target.reasoningEffort].filter(Boolean).join(" / ")}]`;
  }).join("");
}
