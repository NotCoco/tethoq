import { providerPromptContent, type SendMessageRequest } from "../../provider_contract/src/index.js";

export type CodexTurnInput =
  | { readonly type: "text"; readonly text: string; readonly text_elements: readonly unknown[] }
  | { readonly type: "image" | "audio"; readonly url: string };

/** Builds the same native UserInput array for local and Desktop-owned turns. */
export function codexTurnInput(request: SendMessageRequest): readonly CodexTurnInput[] {
  const input: CodexTurnInput[] = [
    { type: "text", text: providerPromptContent(request), text_elements: [] },
  ];
  for (const attachment of request.attachments ?? []) {
    const mimeType = attachment.mimeType.toLowerCase();
    if (mimeType.startsWith("image/")) input.push({ type: "image", url: `data:${attachment.mimeType};base64,${attachment.dataBase64}` });
    else if (mimeType.startsWith("audio/")) input.push({ type: "audio", url: `data:${attachment.mimeType};base64,${attachment.dataBase64}` });
  }
  return input;
}
