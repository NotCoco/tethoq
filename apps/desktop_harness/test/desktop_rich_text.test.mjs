import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(appRoot, "node_modules", ".tethoq-test", `rich-text-${process.pid}-${Date.now()}`);
const bundle = join(outputDirectory, "rich-text.mjs");
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "RichText.tsx")],
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["react", "react-dom"],
});
const { RichText, codeBlockText, localLocationFromHref, localPathSegments, safeMarkdownUrl } = await import(`file:///${bundle.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

test("rich transcript text renders GFM structure and ordinary line breaks", () => {
  const markdown = [
    "### Supabase Free",
    "",
    "| Feature | Free |",
    "| --- | --- |",
    "| API requests | Unlimited |",
    "",
    "- First item",
    "- Second item",
    "",
    "> A concise note",
    "",
    "[Documentation](https://example.test/docs) and `inline code`.",
    "",
    "```ts",
    "const ready = true;",
    "```",
    "line one",
    "line two",
    "",
    "![Chart](https://example.test/chart.png)",
  ].join("\n");
  const markup = renderToStaticMarkup(React.createElement(RichText, { onImageOpen: () => undefined, onLinkOpen: () => undefined }, markdown));
  assert.match(markup, /<h3>Supabase Free<\/h3>/);
  assert.match(markup, /<table>/);
  assert.match(markup, /<th>Feature<\/th>/);
  assert.match(markup, /<ul>/);
  assert.match(markup, /<blockquote>/);
  assert.match(markup, /<a href="https:\/\/example\.test\/docs">Documentation<\/a>/);
  assert.doesNotMatch(markup, /target="_blank"/);
  assert.match(markup, /<pre><code class="language-ts">/);
  assert.match(markup, /class="rich-code-copy"[^>]*aria-label="Copy code"/);
  assert.doesNotMatch(markup, />Copy<\/span>/);
  assert.match(markup, /class="rich-code-copy-status" role="status" aria-live="polite"/);
  assert.equal(codeBlockText(React.createElement("code", { className: "language-ts" }, "const ready = true;\n")), "const ready = true;");
  assert.match(markup, /line one<br\/>\nline two/);
  assert.match(markup, /class="rich-text-image"/);
});

test("rich transcript text drops raw HTML and unsafe URL protocols", () => {
  const markdown = "<script>alert('no')</script><img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert(1)) ![local](file:///C:/secret.svg)";
  const markup = renderToStaticMarkup(React.createElement(RichText, null, markdown));
  assert.doesNotMatch(markup, /<script|onerror|javascript:|file:\/\//iu);
  assert.doesNotMatch(markup, /secret\.svg/iu);
  assert.equal(safeMarkdownUrl("javascript:alert(1)", "href"), "");
  assert.equal(safeMarkdownUrl("mailto:private@example.test", "href"), "");
  assert.equal(safeMarkdownUrl("/relative", "href"), "");
  assert.equal(safeMarkdownUrl("https://example.test/docs", "href"), "https://example.test/docs");
  assert.equal(safeMarkdownUrl("file:///C:/example-repo/package.json", "href"), "file:///C:/example-repo/package.json");
  assert.equal(safeMarkdownUrl("file:///C:/secret.svg", "src"), "");
  assert.equal(safeMarkdownUrl("file://server/share/secret.png", "src"), "");
  assert.equal(safeMarkdownUrl("https://example.test/image.png", "src"), "https://example.test/image.png");
});

test("local transcript videos render as bounded playable media with an open action", () => {
  const markdown = [
    "![Demo 20-second sequence](<C:\\Users\\test\\Documents\\demo_sequence_review.mp4>)",
    "",
    "[Open alternate](C:/example-repo/outputs/alternate.webm)",
  ].join("\n");
  const markup = renderToStaticMarkup(React.createElement(RichText, null, markdown));
  assert.equal((markup.match(/class="rich-local-video"/g) ?? []).length, 2);
  assert.match(markup, /<video src="tethoq-media:\/\/local\/C%3A%5CUsers%5Ctest%5CDocuments%5Cdemo_sequence_review\.mp4" controls="" preload="metadata" playsInline=""/);
  assert.match(markup, /aria-label="Demo 20-second sequence"/);
  assert.match(markup, /class="rich-local-video-open">Demo 20-second sequence<\/a>/);
  assert.match(markup, /aria-label="Open alternate"/);
  assert.doesNotMatch(markup, /autoplay/iu);
  assert.match(safeMarkdownUrl("file:///C:/clips/review.mp4", "src"), /^tethoq-media:\/\/local\//u);
  assert.match(safeMarkdownUrl("file:///C:/captures/review.png", "src"), /^tethoq-media:\/\/local\//u);
});

test("local transcript images render as expandable widgets without exposing file URLs", async () => {
  const markdown = "![Updated side-chat stack](<C:/Users/test/AppData/Local/Temp/Tethoq QA/side-chat-rail.png>)";
  const markup = renderToStaticMarkup(React.createElement(RichText, { onImageOpen: () => undefined }, markdown));
  assert.match(markup, /class="rich-text-image"/u);
  assert.match(markup, /aria-label="Expand Updated side-chat stack"/u);
  assert.match(markup, /src="tethoq-media:\/\/local\/C%3A%2FUsers%2Ftest%2FAppData%2FLocal%2FTemp%2FTethoq%20QA%2Fside-chat-rail\.png"/u);
  assert.doesNotMatch(markup, /file:\/\//u);
  assert.doesNotMatch(markup, /rich-local-video/u);
  const source = await readFile(join(appRoot, "src", "renderer", "src", "RichText.tsx"), "utf8");
  assert.match(source, /onError=\{\(\) => setFailedSource\(source\)\}/u, "a missing local image keeps a calm unavailable fallback");
});

test("local transcript videos keep their intrinsic aspect ratio instead of filling the message width", async () => {
  const [styles, richText] = await Promise.all([
    readFile(join(appRoot, "src", "renderer", "src", "styles.css"), "utf8"),
    readFile(join(appRoot, "src", "renderer", "src", "RichText.tsx"), "utf8"),
  ]);
  assert.match(styles, /\.rich-local-video \{[^}]*width: fit-content;[^}]*display: inline-flex;[^}]*flex-direction: column;/su);
  assert.match(styles, /\.rich-local-video video \{[^}]*width: auto;[^}]*height: auto;[^}]*max-width: 100%;[^}]*max-height: 420px;/su);
  assert.match(richText, /const components = useMemo<Components>\(\(\) => \(\{/u, "unrelated task refreshes must not remount video renderers");
  assert.match(richText, /export const RichText = memo\(function RichText/u);
});

test("local Windows paths and file URIs become safe open actions without touching fenced code", () => {
  const markdown = [
    "Open C:\\example-repo\\apps\\desktop_harness\\package.json:12 or `C:\\Program Files\\Tethoq\\notes.txt`.",
    "Also C:\\Users\\example\\My Documents\\file.ts:12 is actionable without extra Markdown.",
    "",
    "[Workspace](file:///C:/example-repo/apps/desktop_harness)",
    "[Source](C:/Users/example/My%20Documents/file.ts:9)",
    "Raw URI: file:///C:/example-repo/README.md",
    "",
    "```text",
    "C:\\example-repo\\do-not-link-inside-a-snippet.txt",
    "```",
  ].join("\n");
  const markup = renderToStaticMarkup(React.createElement(RichText, null, markdown));
  assert.equal((markup.match(/class="rich-local-path"/g) ?? []).length, 6);
  assert.match(markup, /<a href="#" class="rich-local-path">C:\\example-repo\\apps\\desktop_harness\\package\.json:12<\/a>/);
  assert.match(markup, /<a href="#" class="rich-local-path"><code>C:\\Program Files\\Tethoq\\notes\.txt<\/code><\/a>/);
  assert.match(markup, /<pre><code class="language-text">C:\\example-repo\\do-not-link-inside-a-snippet\.txt/);
  const first = localPathSegments("See C:\\example-repo\\README.md:44:3.").find((segment) => segment.location)?.location;
  assert.deepEqual(first, { path: "C:\\example-repo\\README.md", line: 44, column: 3 });
  const spaced = localPathSegments("C:\\Users\\example\\My Documents\\file.ts:12").find((segment) => segment.location)?.location;
  assert.deepEqual(spaced, { path: "C:\\Users\\example\\My Documents\\file.ts", line: 12 });
  assert.deepEqual(localLocationFromHref("file:///C:/example-repo/README.md"), { path: "C:/example-repo/README.md" });
  assert.equal(localLocationFromHref("file://server/share/file.txt"), null);
});
