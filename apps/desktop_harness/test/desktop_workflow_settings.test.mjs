import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const source = (path) => readFile(join(appRoot, path), "utf8");

test("recorded workflows keeps the resting surface quiet", async () => {
  const [component, styles] = await Promise.all([
    source(join("src", "renderer", "src", "WorkflowSettings.tsx")),
    source(join("src", "renderer", "src", "workflow-settings.css")),
  ]);

  assert.doesNotMatch(component, /\{workflows\.length\} saved|Local to this computer|No saved workflows|Use the task composer|Record explicitly, attach within one task/);
  assert.doesNotMatch(component, /EmptyState|workflow-settings-toolbar|workflow-settings-card/);
  assert.match(component, /className="workflow-settings-header"/);
  assert.match(component, /className="workflow-action workflow-record-action"/);
  assert.match(styles, /\.workflow-settings-section \{[\s\S]*?width: min\(720px, 100%\)/);
  assert.match(styles, /\.workflow-settings-section \.workflow-action \{[\s\S]*?border-color: transparent;[\s\S]*?background: transparent;/);
  assert.match(styles, /\.workflow-settings-section \.workflow-action:hover:not\(:disabled\),[\s\S]*?\.workflow-settings-section \.workflow-action:focus-visible/);
  assert.match(styles, /\.workflow-entry-copy strong \{ font-size: 15px/);
});

test("workflow rows disclose details accessibly and progressively", async () => {
  const component = await source(join("src", "renderer", "src", "WorkflowSettings.tsx"));

  assert.match(component, /aria-expanded=\{isSelected\}/);
  assert.match(component, /aria-controls=\{detailId\}/);
  assert.match(component, /onSelectWorkflow\(isSelected \? null : workflow\.id\)/);
  assert.match(component, /<details className="workflow-capture-details" onToggle=/);
  assert.match(component, /<summary>Capture details<\/summary>/);
  assert.match(component, /role="group" aria-label="Capture summary"/);
  assert.match(component, /className="workflow-detail-timing workflow-captured-data"/);
  assert.match(component, /className="workflow-action workflow-close-action"/);
});

test("capture details lazy-load a named screenshot slider and full preview", async () => {
  const [component, styles, app] = await Promise.all([
    source(join("src", "renderer", "src", "WorkflowSettings.tsx")),
    source(join("src", "renderer", "src", "workflow-settings.css")),
    source(join("src", "renderer", "src", "App.tsx")),
  ]);

  assert.match(component, /captureDetailsOpen && workflow\.summary\.screenshotCount > 0/);
  assert.match(component, /onListScreenshots\(workflow\.id\)/);
  assert.match(component, /new IntersectionObserver/);
  assert.match(component, /variant: "thumbnail" \| "full"/);
  assert.match(component, /role="list"/);
  assert.match(component, /<small>\{screenshot\.name\}<\/small>/);
  assert.match(component, /role="dialog" aria-modal="true" aria-label=\{`Preview/);
  assert.match(component, /lightboxRef\.current\?\.querySelector<HTMLElement>\('button\[aria-label="Close screenshot preview"\]'\)\?\.focus\(\)/);
  assert.match(component, /target\.isConnected && target\.focus\(\)/);
  assert.match(component, /aria-label="Previous screenshot"/);
  assert.match(component, /aria-label="Next screenshot"/);
  assert.match(styles, /\.workflow-screenshot-strip \{[\s\S]*?grid-auto-flow: column;[\s\S]*?scroll-snap-type: inline mandatory;/);
  assert.match(styles, /\.workflow-screenshot-strip:hover::-webkit-scrollbar-thumb/);
  assert.match(styles, /\.workflow-screenshot-lightbox \{[\s\S]*?position: fixed;/);
  assert.match(app, /type: "screenshots", id/);
  assert.match(app, /type: "screenshot-data", id, frameId, variant/);
});
