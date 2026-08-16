import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
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
  assert.match(markup, /class="rich-code-copy" aria-label="Copy code"/);
  assert.match(markup, /class="rich-code-copy-status" role="status" aria-live="polite"/);
  assert.equal(codeBlockText(React.createElement("code", { className: "language-ts" }, "const ready = true;\n")), "const ready = true;");
  assert.match(markup, /line one<br\/>\nline two/);
  assert.match(markup, /class="rich-text-image"/);
});

test("rich transcript text drops raw HTML and unsafe URL protocols", () => {
  const markdown = "<script>alert('no')</script><img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert(1)) ![local](file:///C:/secret.png)";
  const markup = renderToStaticMarkup(React.createElement(RichText, null, markdown));
  assert.doesNotMatch(markup, /<script|onerror|javascript:|file:\/\//iu);
  assert.doesNotMatch(markup, /secret\.png/iu);
  assert.equal(safeMarkdownUrl("javascript:alert(1)", "href"), "");
  assert.equal(safeMarkdownUrl("mailto:private@example.test", "href"), "");
  assert.equal(safeMarkdownUrl("/relative", "href"), "");
  assert.equal(safeMarkdownUrl("https://example.test/docs", "href"), "https://example.test/docs");
  assert.equal(safeMarkdownUrl("file:///C:/cli_remote/package.json", "href"), "file:///C:/cli_remote/package.json");
  assert.equal(safeMarkdownUrl("file:///C:/secret.png", "src"), "");
  assert.equal(safeMarkdownUrl("https://example.test/image.png", "src"), "https://example.test/image.png");
});

test("local Windows paths and file URIs become safe open actions without touching fenced code", () => {
  const markdown = [
    "Open C:\\cli_remote\\apps\\desktop_harness\\package.json:12 or `C:\\Program Files\\Tethoq\\notes.txt`.",
    "Also C:\\Users\\example\\My Documents\\file.ts:12 is actionable without extra Markdown.",
    "",
    "[Workspace](file:///C:/cli_remote/apps/desktop_harness)",
    "[Source](C:/Users/example/My%20Documents/file.ts:9)",
    "Raw URI: file:///C:/cli_remote/README.md",
    "",
    "```text",
    "C:\\cli_remote\\do-not-link-inside-a-snippet.txt",
    "```",
  ].join("\n");
  const markup = renderToStaticMarkup(React.createElement(RichText, null, markdown));
  assert.equal((markup.match(/class="rich-local-path"/g) ?? []).length, 6);
  assert.match(markup, /<a href="#" class="rich-local-path">C:\\cli_remote\\apps\\desktop_harness\\package\.json:12<\/a>/);
  assert.match(markup, /<a href="#" class="rich-local-path"><code>C:\\Program Files\\Tethoq\\notes\.txt<\/code><\/a>/);
  assert.match(markup, /<pre><code class="language-text">C:\\cli_remote\\do-not-link-inside-a-snippet\.txt/);
  const first = localPathSegments("See C:\\cli_remote\\README.md:44:3.").find((segment) => segment.location)?.location;
  assert.deepEqual(first, { path: "C:\\cli_remote\\README.md", line: 44, column: 3 });
  const spaced = localPathSegments("C:\\Users\\example\\My Documents\\file.ts:12").find((segment) => segment.location)?.location;
  assert.deepEqual(spaced, { path: "C:\\Users\\example\\My Documents\\file.ts", line: 12 });
  assert.deepEqual(localLocationFromHref("file:///C:/cli_remote/README.md"), { path: "C:/cli_remote/README.md" });
  assert.equal(localLocationFromHref("file://server/share/file.txt"), null);
});
