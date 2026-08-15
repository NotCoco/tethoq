import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultTranscriptionSourceRegistry,
  OpenAiDictationTranscriber,
  XAiDictationTranscriber,
} from "./dictation.js";

test("dictation uses an explicit Tethoq credential and the official transcription model", async () => {
  const apiKey = ["test", "tethoq", "openai", "key"].join("-");
  let request: { readonly url: string; readonly init: RequestInit | undefined } | undefined;
  const transcriber = new OpenAiDictationTranscriber({
    apiKey,
    fetch: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ text: "  OpenCode and Kronos  " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const bytes = Buffer.alloc(2_000, 7);

  const result = await transcriber.transcribe({
    name: "dictation.wav",
    mimeType: "audio/wav",
    byteLength: bytes.byteLength,
    dataBase64: bytes.toString("base64"),
  }, { dictionary: ["OpenCode", "Kronos", "OpenCode"] });

  assert.equal(result.text, "OpenCode and Kronos");
  assert.equal(request?.url, "https://api.openai.com/v1/audio/transcriptions");
  const headers = new Headers(request?.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
  assert.equal(headers.get("chatgpt-account-id"), null);
  assert.equal(headers.get("originator"), null);
  const form = request?.init?.body as FormData;
  assert.equal(form.get("model"), "gpt-4o-transcribe");
  assert.equal(form.get("prompt"), "Preferred spellings and vocabulary: OpenCode, Kronos");
  assert.ok(form.get("file") instanceof Blob);
});

test("xAI dictation uses bearer auth, keyterms, and places the file last", async () => {
  const apiKey = ["test", "tethoq", "xai", "key"].join("-");
  let request: { readonly url: string; readonly init: RequestInit | undefined } | undefined;
  const transcriber = new XAiDictationTranscriber({
    apiKey,
    fetch: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ text: "  Provider-neutral transcript  " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const bytes = Buffer.alloc(2_000, 9);

  const result = await transcriber.transcribe({
    name: "dictation.wav",
    mimeType: "audio/wav",
    byteLength: bytes.byteLength,
    dataBase64: bytes.toString("base64"),
  }, { dictionary: ["OpenCode", "Kronos"] });

  assert.equal(result.text, "Provider-neutral transcript");
  assert.equal(request?.url, "https://api.x.ai/v1/stt");
  const headers = new Headers(request?.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
  const entries = [...(request?.init?.body as FormData).entries()];
  assert.deepEqual(entries.slice(0, 2), [["keyterm", "OpenCode"], ["keyterm", "Kronos"]]);
  assert.equal(entries.at(-1)?.[0], "file");
  assert.equal((request?.init?.body as FormData).get("model"), null);
});

test("transcription source discovery reports readiness without leaking credentials", () => {
  const openAiApiKey = ["private", "openai", "credential"].join("-");
  const xAiApiKey = ["private", "xai", "credential"].join("-");
  const registry = defaultTranscriptionSourceRegistry({ openAiApiKey, xAiApiKey });

  const sources = registry.list();

  assert.deepEqual(sources.map((source) => ({
    id: source.id,
    label: source.label,
    status: source.status,
    batch: source.capabilities.batch,
    maxAudioBytes: source.capabilities.maxAudioBytes,
  })), [
    {
      id: "openai-stt",
      label: "OpenAI speech-to-text",
      status: "ready",
      batch: true,
      maxAudioBytes: 4 * 1024 * 1024,
    },
    {
      id: "xai-stt",
      label: "xAI speech-to-text",
      status: "ready",
      batch: true,
      maxAudioBytes: 25 * 1024 * 1024,
    },
  ]);
  const serialized = JSON.stringify(sources);
  assert.doesNotMatch(serialized, new RegExp(openAiApiKey));
  assert.doesNotMatch(serialized, new RegExp(xAiApiKey));
  assert.match(serialized, /TETHOQ_OPENAI_API_KEY/);
  assert.match(serialized, /XAI_API_KEY/);
});

test("transcription source registry validates source IDs and credentials before fetching", async () => {
  let called = false;
  const registry = defaultTranscriptionSourceRegistry({
    openAiApiKey: "",
    xAiApiKey: "",
    fetch: async () => {
      called = true;
      return new Response();
    },
  });
  const bytes = Buffer.alloc(2_000);
  const audio = {
    name: "dictation.wav",
    mimeType: "audio/wav",
    byteLength: bytes.byteLength,
    dataBase64: bytes.toString("base64"),
  };

  assert.deepEqual(registry.list().map((source) => source.status), ["needs_credential", "needs_credential"]);
  await assert.rejects(() => registry.transcribe("missing", audio), /not supported/);
  await assert.rejects(() => registry.transcribe("xai-stt", audio), /XAI_API_KEY/);
  assert.equal(called, false);
});

test("dictation rejects missing Tethoq credentials before making a network request", async () => {
  let called = false;
  const transcriber = new OpenAiDictationTranscriber({
    apiKey: "",
    fetch: async () => {
      called = true;
      return new Response();
    },
  });
  const bytes = Buffer.alloc(2_000);

  await assert.rejects(() => transcriber.transcribe({
    name: "dictation.wav",
    mimeType: "audio/wav",
    byteLength: bytes.byteLength,
    dataBase64: bytes.toString("base64"),
  }), /TETHOQ_OPENAI_API_KEY/);
  assert.equal(called, false);
});
