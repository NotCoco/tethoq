export type ToastTone = "normal" | "error";

export function visibleToastFeedback(message: string, tone?: ToastTone): { readonly message: string; readonly tone: "error" } | null {
  return tone === "error" ? { message, tone } : null;
}
