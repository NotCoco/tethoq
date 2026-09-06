import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(tmpdir(), `tethoq-local-media-${process.pid}-${Date.now()}`);
const bundle = join(outputDirectory, "local-media.mjs");
await mkdir(outputDirectory, { recursive: true });
await build({ entryPoints: [join(appRoot, "src", "shared", "local_media.ts")], outfile: bundle, bundle: true, format: "esm", platform: "node", target: "node22" });
const media = await import(`file:///${bundle.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

test("local media URLs classify and round-trip bounded image and video references", () => {
  const windowsPath = "C:\\Users\\test\\Videos\\demo review.mp4";
  const url = media.localMediaUrl(windowsPath);
  assert.equal(url, "tethoq-media://local/C%3A%5CUsers%5Ctest%5CVideos%5Cdemo%20review.mp4");
  assert.equal(media.localMediaPathFromUrl(url), windowsPath);
  assert.equal(media.localMediaPathFromUrl("tethoq-media://other/C%3A%5Csecret.mp4"), null);
  assert.equal(media.localMediaPathFromUrl("file:///C:/secret.mp4"), null);
  assert.equal(media.isLocalVideoPath(windowsPath), true);
  assert.equal(media.isLocalVideoPath("C:\\Users\\test\\Videos\\notes.txt"), false);
  assert.equal(media.isLocalImagePath("C:\\Users\\test\\Pictures\\QA capture.PNG"), true);
  assert.equal(media.isLocalImagePath("C:\\Users\\test\\Pictures\\unsafe.svg"), false);
  assert.equal(media.localMediaContentType("C:\\capture.jpeg"), "image/jpeg");
  assert.equal(media.localMediaContentType("C:\\capture.webp"), "image/webp");
  assert.equal(media.localMediaContentType("C:\\clip.mov"), "video/quicktime");
  assert.equal(media.localMediaContentType("C:\\notes.txt"), null);
  assert.equal(media.localMediaPathFromReference("file:///C:/Users/test/Pictures/QA%20capture.png"), "C:/Users/test/Pictures/QA capture.png");
  assert.equal(media.localMediaPathFromReference("C:\\Users\\test\\Pictures\\QA capture.png"), "C:\\Users\\test\\Pictures\\QA capture.png");
  assert.equal(media.localMediaPathFromReference("/tmp/QA%20capture.png"), "/tmp/QA capture.png");
  assert.equal(media.localMediaPathFromReference("file://server/share/private.png"), null);
  assert.equal(media.localMediaPathFromReference("\\\\server\\share\\private.png"), null);
  assert.equal(media.localMediaPathFromReference("relative.png"), null);
  assert.deepEqual(media.localMediaRange(null, 1_000), { kind: "full" });
  assert.deepEqual(media.localMediaRange("bytes=0-", 1_000), { kind: "partial", start: 0, end: 999 });
  assert.deepEqual(media.localMediaRange("bytes=100-249", 1_000), { kind: "partial", start: 100, end: 249 });
  assert.deepEqual(media.localMediaRange("bytes=-100", 1_000), { kind: "partial", start: 900, end: 999 });
  assert.deepEqual(media.localMediaRange("bytes=1000-", 1_000), { kind: "unsatisfiable" });
});

test("the local media protocol validates files before streaming them with request headers", async () => {
  const source = await readFile(join(appRoot, "src", "main", "local_media.ts"), "utf8");
  assert.match(source, /supportFetchAPI: true, stream: true/);
  assert.match(source, /existingLocalTarget\(path\)/);
  assert.match(source, /target\.kind !== "file"/);
  assert.match(source, /localMediaContentType\(path\) === null/);
  assert.match(source, /isLocalImagePath\(target\.path\)/);
  assert.match(source, /MAX_LOCAL_IMAGE_BYTES\s*=\s*25 \* 1024 \* 1024/);
  assert.match(source, /openAsBlob\(target\.path, \{ type: contentType \}\)/);
  assert.match(source, /file\.slice\(start, end \+ 1, contentType\)/);
  assert.match(source, /status: range\.kind === "partial" \? 206 : 200/);
  assert.match(source, /"Content-Range": `bytes \$\{start\}-\$\{end\}\/\$\{size\}`/);
  assert.match(source, /request\.method !== "GET"/);
});
