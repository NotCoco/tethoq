import { Buffer } from "node:buffer";
import type { WorkflowReference } from "../../protocol/src/index.js";
import type { SendMessageRequest } from "./types.js";

const guidanceStart = "<tethoq_response_guidance>";
const guidanceEnd = "</tethoq_response_guidance>";
const workflowsStart = "<tethoq_workflow_attachments>";
const workflowsEnd = "</tethoq_workflow_attachments>";

function workflowPayload(workflows: readonly WorkflowReference[]): string {
  return Buffer.from(JSON.stringify(workflows), "utf8").toString("base64url");
}

function workflowGuidance(workflows: readonly WorkflowReference[]): string {
  const references = workflows.map((workflow) =>
    `- ${workflow.name}: ${workflow.promptReference ?? "Open the attached Tethoq workflow when it is relevant."}`
  ).join("\n");
  return [
    "The user attached local Tethoq workflow recordings. Use them when relevant to the request, but do not repeat these control notes or local paths unless asked.",
    references,
    `${workflowsStart}${workflowPayload(workflows)}${workflowsEnd}`,
  ].join("\n");
}

export function providerDeveloperInstructions(request: Pick<SendMessageRequest, "developerInstructions" | "workflows">): string | undefined {
  const guidance = [
    request.developerInstructions,
    request.workflows?.length ? workflowGuidance(request.workflows) : undefined,
  ].filter((value): value is string => Boolean(value)).join("\n\n");
  return guidance || undefined;
}

/** Fallback for provider APIs without a per-turn developer/instructions field. */
export function providerPromptContent(request: Pick<SendMessageRequest, "content" | "developerInstructions" | "workflows">): string {
  const guidance = providerDeveloperInstructions(request);
  if (!guidance) return request.content;
  return `${guidanceStart}\n${guidance}\n${guidanceEnd}\n\n${request.content}`;
}

/** Keeps fallback control guidance out of normalized user-visible history. */
export function stripProviderPromptGuidance(value: string): string {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith(guidanceStart)) return value;
  const end = trimmed.indexOf(guidanceEnd);
  if (end < 0) return value;
  return trimmed.slice(end + guidanceEnd.length).trimStart();
}

/** Recovers Tethoq's structured workflow chips before the private prompt envelope is removed. */
export function providerPromptWorkflows(value: string): readonly WorkflowReference[] {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith(guidanceStart)) return [];
  const start = trimmed.indexOf(workflowsStart);
  const end = start < 0 ? -1 : trimmed.indexOf(workflowsEnd, start + workflowsStart.length);
  if (start < 0 || end < 0) return [];
  try {
    const encoded = trimmed.slice(start + workflowsStart.length, end);
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!Array.isArray(parsed)) return [];
    const result: WorkflowReference[] = [];
    for (const entry of parsed.slice(0, 4)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const input = entry as Record<string, unknown>;
      if (typeof input.id !== "string" || typeof input.name !== "string" || !Number.isSafeInteger(input.eventCount) || !Number.isSafeInteger(input.screenshotCount)) continue;
      const applications = Array.isArray(input.applications)
        ? input.applications.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 8)
        : [];
      result.push({
        id: input.id.slice(0, 160),
        name: input.name.slice(0, 160),
        eventCount: Math.max(0, input.eventCount as number),
        screenshotCount: Math.max(0, input.screenshotCount as number),
        ...(applications.length ? { applications } : {}),
      });
    }
    return result;
  } catch {
    return [];
  }
}
