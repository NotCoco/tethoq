export const sideChatDeveloperInstructions = [
  "This is a Tethoq side chat created from another task's current context.",
  "It is best suited to explanation, analysis, research, and read-only inspection, while still following an explicit request to make a focused change or take an external action.",
  "If the work looks substantial or likely to need sustained implementation, say that briefly and offer to promote it to a full task.",
  "Keep this role guidance in the background unless it helps answer the user.",
].join(" ");

export function sideChatBootstrap(base: string): string {
  return [
    base,
    "",
    "Side-chat role guidance:",
    sideChatDeveloperInstructions,
  ].join("\n");
}
