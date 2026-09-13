import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(tmpdir(), `tethoq-annotations-${process.pid}-${Date.now()}`);
const annotationBundle = join(outputDirectory, "response-annotations.mjs");
const timelineBundle = join(outputDirectory, "timeline-merge.mjs");
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  build({ entryPoints: [join(appRoot, "src", "renderer", "src", "response_annotations.ts")], outfile: annotationBundle, bundle: true, format: "esm", platform: "node", target: "node22" }),
  build({ entryPoints: [join(appRoot, "src", "renderer", "src", "timeline_merge.ts")], outfile: timelineBundle, bundle: true, format: "esm", platform: "node", target: "node22" }),
]);
const annotations = await import(`file:///${annotationBundle.replaceAll("\\", "/")}`);
const timeline = await import(`file:///${timelineBundle.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

test("response annotation envelopes round-trip without leaking protocol prose", () => {
  const items = [
    { id: "a1", text: "First selected answer", annotation: "Explain this more simply." },
    { id: "a2", text: "Second selected answer", annotation: "This claim needs evidence." },
  ];
  const wire = annotations.serializeResponseAnnotations("Add one short conclusion.", items);
  const parsed = annotations.parseResponseAnnotations(wire);

  assert.equal(parsed.body, "Add one short conclusion.");
  assert.deepEqual(parsed.annotations.map(({ text, annotation }) => ({ text, annotation })), items.map(({ text, annotation }) => ({ text, annotation })));
  assert.equal(annotations.visibleResponseAnnotationBody(wire), "Add one short conclusion.");
  assert.match(wire, /<response-annotations>/u);
  assert.doesNotMatch(parsed.body, /Response annotations|codex-annotation|My request/u);
});

test("the older bare JSON annotation envelope reopens as compact annotation data", () => {
  const wire = `# Response annotations:\nInstructions that belong to the transport.\n[{"text":"Selected words","annotation":"Make this clearer."}]\n\n## My request:\n`;
  const parsed = annotations.parseResponseAnnotations(wire);

  assert.equal(parsed.body, "");
  assert.equal(parsed.annotations.length, 1);
  assert.equal(parsed.annotations[0].text, "Selected words");
  assert.equal(parsed.annotations[0].annotation, "Make this clearer.");
});

test("selection-only annotations stay widgets and never expose their transport envelope", () => {
  const wire = `# Response annotations:\nInstructions that belong to the transport.\n[{"text":"Codex Desktop writer"}]\n\n## My request:\nDoes this require Codex Desktop?`;
  const parsed = annotations.parseResponseAnnotations(wire);

  assert.equal(parsed.body, "Does this require Codex Desktop?");
  assert.deepEqual(parsed.annotations.map(({ text, annotation }) => ({ text, annotation })), [
    { text: "Codex Desktop writer", annotation: "" },
  ]);
  assert.equal(annotations.visibleResponseAnnotationBody(wire), "Does this require Codex Desktop?");
  assert.doesNotMatch(parsed.body, /Response annotations|Codex Desktop writer|My request/u);
});

test("ordinary prose that mentions annotations remains ordinary prose", () => {
  const text = "Documentation example: # Response annotations: and ## My request:";
  assert.equal(annotations.parseResponseAnnotations(text), null);
  assert.equal(annotations.visibleResponseAnnotationBody(text), text);
});

test("annotation audio stays associated with its numbered detail across history", () => {
  const clip = { path: "voice:1", name: "annotation.mp3", mimeType: "audio/mpeg", byteLength: 12, dataBase64: "AA==", durationSeconds: 1, origin: "dictation" };
  const wire = annotations.serializeResponseAnnotations("", [
    { id: "a1", text: "Text comment", annotation: "Clarify this." },
    { id: "a2", text: "Voice comment", annotation: "", audio: clip },
  ], 1);
  const parsed = annotations.parseResponseAnnotations(wire);
  assert.equal(parsed.annotations[1].audioAttachmentIndex, 1);

  const associated = annotations.associateResponseAnnotationAudio(parsed.annotations, ["message recording", "annotation recording"]);
  assert.equal(associated.annotations[0].audio, undefined);
  assert.equal(associated.annotations[1].audio, "annotation recording");
  assert.deepEqual(associated.remainingAudio, ["message recording"]);
});

test("annotation-only optimistic rows reconcile with their provider echo", () => {
  const annotation = { id: "local-a", text: "Selected words", annotation: "Explain this." };
  const optimistic = { id: "local-1000", kind: "user", body: "", annotations: [annotation], timestamp: "2026-08-21T10:00:00.000Z", state: "completed" };
  const provider = { id: "provider-user", messageId: "provider-user", kind: "user", body: "", annotations: [{ ...annotation, id: "provider-a" }], timestamp: "2026-08-21T10:00:01.000Z", state: "completed" };

  const reconciled = timeline.reconcileTimelinePage([provider], [optimistic]);
  assert.deepEqual(reconciled.map((item) => item.id), ["provider-user"]);
});
