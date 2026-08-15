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
  assert.match(component, /<details className="workflow-capture-details">/);
  assert.match(component, /<summary>Capture details<\/summary>/);
  assert.match(component, /role="group" aria-label="Capture summary"/);
  assert.match(component, /className="workflow-detail-timing workflow-captured-data"/);
  assert.match(component, /className="workflow-action workflow-close-action"/);
});
