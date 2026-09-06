import { Buffer } from "node:buffer";
import type { MessageAttachment } from "../../provider_contract/src/index.js";
import { ProviderAdapterError } from "../../provider_contract/src/index.js";

const maximumPdfBytes = 25 * 1024 * 1024;
const maximumPdfPages = 100;
const maximumExtractedTextCharacters = 200_000;
const maximumPdfImagePixels = 16_777_216;

export const pdfFallbackTextPreamble =
  "Tethoq extracted this text because the selected OpenCode model does not advertise native PDF input.";

export function isPdfAttachment(attachment: MessageAttachment): boolean {
  return attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
}

export async function extractedPdfTextAttachment(attachment: MessageAttachment): Promise<MessageAttachment> {
  const displayName = readablePdfName(attachment.name);
  let cleanup: (() => Promise<unknown>) | undefined;
  try {
    const bytes = Buffer.from(attachment.dataBase64, "base64");
    if (bytes.byteLength === 0) {
      throw pdfExtractionError(displayName, "The PDF attachment is empty.");
    }
    if (bytes.byteLength > maximumPdfBytes) {
      throw pdfExtractionError(displayName, "The PDF attachment is too large to extract safely.");
    }

    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes), {
      maxImageSize: maximumPdfImagePixels,
      stopAtErrors: true,
      verbosity: 0,
    });
    const destroy = (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.bind(pdf);
    cleanup = async () => {
      try {
        await pdf.cleanup();
      } finally {
        if (destroy !== undefined) await destroy();
      }
    };
    if (!Number.isInteger(pdf.numPages) || pdf.numPages <= 0) {
      throw pdfExtractionError(displayName, "The PDF attachment has no readable pages.");
    }
    if (pdf.numPages > maximumPdfPages) {
      throw pdfExtractionError(
        displayName,
        `The PDF attachment has more than ${maximumPdfPages} pages and cannot be extracted safely.`,
      );
    }

    const extracted = await extractText(pdf, { mergePages: true });
    const normalized = extracted.text.replaceAll("\u0000", "").replace(/\r\n?/gu, "\n").trim();
    if (normalized.length === 0) {
      throw pdfExtractionError(
        displayName,
        "The PDF attachment contains no extractable text. Retry with an unencrypted, text-based PDF.",
      );
    }

    const text = boundedText(normalized, maximumExtractedTextCharacters);
    const truncated = text.length < normalized.length;
    const surrogateText = [
      pdfFallbackTextPreamble,
      `Original PDF: ${displayName}`,
      `Pages: ${extracted.totalPages}`,
      "",
      text,
      ...(truncated ? ["", `[Text truncated after ${maximumExtractedTextCharacters.toLocaleString("en-US")} characters.]`] : []),
    ].join("\n");
    const surrogateBytes = Buffer.from(surrogateText, "utf8");
    return {
      name: `${displayName}.txt`,
      mimeType: "text/plain",
      dataBase64: surrogateBytes.toString("base64"),
      byteLength: surrogateBytes.byteLength,
    };
  } catch (error) {
    if (error instanceof ProviderAdapterError) throw error;
    throw pdfExtractionError(
      displayName,
      "Tethoq could not extract this PDF. Retry with an unencrypted, text-based PDF.",
      error,
    );
  } finally {
    if (cleanup !== undefined) {
      try {
        await cleanup();
      } catch {
        // Extraction has already succeeded or produced the useful failure.
      }
    }
  }
}

function readablePdfName(value: string): string {
  const leaf = value.replaceAll("\\", "/").split("/").at(-1) ?? value;
  const readable = leaf
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (readable || "document.pdf").slice(0, 220);
}

function boundedText(value: string, maximumCharacters: number): string {
  let bounded = value.slice(0, maximumCharacters);
  const finalCodeUnit = bounded.charCodeAt(bounded.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) bounded = bounded.slice(0, -1);
  return bounded.trimEnd();
}

function pdfExtractionError(name: string, message: string, cause?: unknown): ProviderAdapterError {
  return cause === undefined
    ? new ProviderAdapterError("opencode", "PDF_TEXT_EXTRACTION_FAILED", `${message} (${name})`, true)
    : new ProviderAdapterError("opencode", "PDF_TEXT_EXTRACTION_FAILED", `${message} (${name})`, true, { cause });
}
