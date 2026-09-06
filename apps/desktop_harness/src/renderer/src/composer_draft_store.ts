import type { WorkflowAttachment } from "@shared/desktop_api";
import type { ComposerAttachment, ComposerDraftSnapshot, MeshTarget } from "./Composer";
import type { ResponseAnnotation } from "./response_annotations";

export interface ComposerDraftStores {
  content: Record<string, string>;
  attachments: Record<string, readonly ComposerAttachment[]>;
  workflows: Record<string, readonly WorkflowAttachment[]>;
  annotations: Record<string, readonly ResponseAnnotation[]>;
  modes: Record<string, "queue" | "steer">;
  meshTargets: Record<string, readonly MeshTarget[]>;
}

const noAnnotations: readonly ResponseAnnotation[] = Object.freeze([]);

export function composerDraftSnapshot(stores: ComposerDraftStores, sessionId: string): ComposerDraftSnapshot {
  return {
    content: stores.content[sessionId] ?? "",
    attachments: stores.attachments[sessionId] ?? [],
    workflowAttachments: stores.workflows[sessionId] ?? [],
    annotations: stores.annotations[sessionId] ?? noAnnotations,
  };
}

function replaceOptional<T>(store: Record<string, T>, fromId: string, toId: string, value: T | undefined, present: boolean): void {
  delete store[fromId];
  delete store[toId];
  if (present && value !== undefined) store[toId] = value;
}

/** Move one live composition to a provider-created task without dropping edits made while creation was pending. */
export function rebindComposerDraftState(
  stores: ComposerDraftStores,
  fromId: string,
  toId: string,
  retained: ComposerDraftSnapshot,
): void {
  const mode = stores.modes[fromId];
  const meshTargets = stores.meshTargets[fromId];
  replaceOptional(stores.content, fromId, toId, retained.content, retained.content.length > 0);
  replaceOptional(stores.attachments, fromId, toId, retained.attachments, retained.attachments.length > 0);
  replaceOptional(stores.workflows, fromId, toId, retained.workflowAttachments, retained.workflowAttachments.length > 0);
  replaceOptional(stores.annotations, fromId, toId, retained.annotations, retained.annotations.length > 0);
  replaceOptional(stores.modes, fromId, toId, mode, mode !== undefined);
  replaceOptional(stores.meshTargets, fromId, toId, meshTargets, (meshTargets?.length ?? 0) > 0);
}
