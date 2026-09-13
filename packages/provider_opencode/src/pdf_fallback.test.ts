import assert from "node:assert/strict";
import test from "node:test";
import { ProviderAdapterError } from "../../provider_contract/src/index.js";
import type { OpenCodeActivityReader } from "./activity.js";
import type { FetchLike } from "./http_client.js";
import { OpenCodeAdapter } from "./opencode_adapter.js";

const canarySentence = "The cobalt lantern is the PDF canary.";

function idleActivityReader(): OpenCodeActivityReader {
  return {
    async readWorkingSessionIds(): Promise<ReadonlySet<string>> { return new Set(); },
    close(): void {},
  };
}

function requestUrl(input: Parameters<FetchLike>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function providerResponse(pdfCapability: boolean | undefined): Response {
  return jsonResponse({
    connected: ["test-provider"],
    all: [{
      id: "test-provider",
      models: {
        reader: {
          id: "reader",
          ...(pdfCapability === undefined ? {} : { capabilities: { input: { pdf: pdfCapability } } }),
        },
      },
    }],
  });
}

function onePagePdf(text: string, encrypted = false): Buffer {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = text.length === 0 ? "" : `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    ...(encrypted ? [
      "<< /Filter /Standard /V 1 /R 2 /Length 40 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>",
    ] : []),
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, "ascii"));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, "ascii");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  const encryptTrailer = encrypted
    ? " /Encrypt 6 0 R /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]"
    : "";
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptTrailer} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}

function pdfAttachment(bytes: Buffer, name = "one-sentence.pdf") {
  return {
    name,
    mimeType: "application/pdf",
    dataBase64: bytes.toString("base64"),
    byteLength: bytes.byteLength,
  } as const;
}

async function sendPdfWithCapability(pdfCapability: boolean | undefined): Promise<Record<string, unknown>> {
  let requestBody: Record<string, unknown> | undefined;
  const fetchLike: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/provider") return providerResponse(pdfCapability);
    if (url.pathname.startsWith("/session/pdf-fallback/message/")) {
      assert.ok(requestBody);
      return jsonResponse({ info: { id: requestBody.messageID, sessionID: "pdf-fallback", role: "user" }, parts: requestBody.parts });
    }
    assert.equal(url.pathname, "/session/pdf-fallback/prompt_async");
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(null, { status: 204 });
  };
  const adapter = new OpenCodeAdapter({
    directory: "C:/fixture",
    hostId: "host_pdf_fallback",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: idleActivityReader(),
  });
  try {
    await adapter.sendMessage("pdf-fallback", {
      requestId: `pdf-${String(pdfCapability)}`,
      content: "Read the sentence.",
      modelId: "test-provider/reader",
      attachments: [pdfAttachment(onePagePdf(canarySentence))],
    });
  } finally {
    await adapter.dispose();
  }
  assert.ok(requestBody);
  return requestBody;
}

function extractedSurrogate(body: Record<string, unknown>): { readonly part: Record<string, unknown>; readonly text: string } {
  const parts = body.parts;
  assert.ok(Array.isArray(parts));
  assert.equal(parts.length, 2, "one PDF became more than one surrogate part");
  const part = parts[1];
  assert.ok(typeof part === "object" && part !== null && !Array.isArray(part));
  const record = part as Record<string, unknown>;
  assert.equal(record.type, "file");
  assert.equal(record.mime, "text/plain");
  assert.equal(record.filename, "one-sentence.pdf.txt");
  assert.ok(typeof record.url === "string");
  const match = /^data:text\/plain;base64,(.+)$/u.exec(record.url);
  assert.ok(match);
  return { part: record, text: Buffer.from(match[1]!, "base64").toString("utf8") };
}

test("OpenCode extracts a bounded text/plain PDF surrogate when native PDF capability is false", async () => {
  const body = await sendPdfWithCapability(false);
  const { text } = extractedSurrogate(body);

  assert.match(text, /Original PDF: one-sentence\.pdf/u);
  assert.match(text, /Pages: 1/u);
  assert.match(text, new RegExp(canarySentence.replaceAll(".", "\\."), "u"));
  assert.doesNotMatch(JSON.stringify(body), /data:application\/pdf/u);
});

test("OpenCode treats a missing native PDF capability as unsupported", async () => {
  const body = await sendPdfWithCapability(undefined);
  const { text } = extractedSurrogate(body);

  assert.match(text, /does not advertise native PDF input/u);
  assert.match(text, /The cobalt lantern is the PDF canary\./u);
});

test("malformed, encrypted, and textless PDF fallbacks fail before prompt_async and remain retryable", async (t) => {
  const cases = [
    { name: "malformed", bytes: Buffer.from("not a PDF", "utf8") },
    { name: "encrypted", bytes: onePagePdf("Secret", true) },
    { name: "textless", bytes: onePagePdf("") },
  ] as const;

  for (const failure of cases) {
    await t.test(failure.name, async () => {
      let promptWrites = 0;
      let storedPrompt: Record<string, unknown> | undefined;
      const fetchLike: FetchLike = async (input, init) => {
        const url = requestUrl(input);
        if (url.pathname === "/provider") return providerResponse(false);
        if (url.pathname.endsWith("/prompt_async")) {
          promptWrites += 1;
          storedPrompt = JSON.parse(String(init?.body)) as Record<string, unknown>;
        }
        if (url.pathname.startsWith("/session/pdf-failure/message/")) {
          assert.ok(storedPrompt);
          return jsonResponse({ info: { id: storedPrompt.messageID, sessionID: "pdf-failure", role: "user" }, parts: storedPrompt.parts });
        }
        return new Response(null, { status: 204 });
      };
      const adapter = new OpenCodeAdapter({
        directory: "C:/fixture",
        hostId: "host_pdf_failure",
        baseUrl: "http://127.0.0.1:4096/",
        fetch: fetchLike,
        activityReader: idleActivityReader(),
      });
      t.after(() => adapter.dispose());

      await assert.rejects(
        () => adapter.sendMessage("pdf-failure", {
          requestId: `pdf-failure-${failure.name}`,
          content: "Read this PDF.",
          modelId: "test-provider/reader",
          attachments: [pdfAttachment(failure.bytes, `${failure.name}.pdf`)],
        }),
        (error: unknown) => error instanceof ProviderAdapterError
          && error.code === "PDF_TEXT_EXTRACTION_FAILED"
          && error.retryable,
      );
      assert.equal(promptWrites, 0, "a failed fallback reached prompt_async");
      assert.equal(adapter.hasActiveTurn("pdf-failure"), false, "a failed fallback left a phantom active prompt");

      await adapter.sendMessage("pdf-failure", {
        requestId: `pdf-failure-${failure.name}`,
        content: "Read this PDF.",
        modelId: "test-provider/reader",
        attachments: [pdfAttachment(onePagePdf(canarySentence), `${failure.name}.pdf`)],
      });
      assert.equal(promptWrites, 1, "the corrected retry was blocked after a local extraction failure");
    });
  }
});
