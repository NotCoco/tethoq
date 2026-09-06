import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rendererRoot = join(appRoot, "src", "renderer", "src");
const source = (name) => readFile(join(rendererRoot, name), "utf8");

test("dashboard keeps its hierarchy readable and adapts before stacking", async () => {
  const [app, styles] = await Promise.all([source("App.tsx"), source("styles.css")]);
  assert.match(app, /<Status state=\{active\.state\} compact \/> : null\}Active now/);
  assert.match(app, /className="attention-heading">Needs attention <b>\{attention\.length\}<\/b>/);
  assert.match(app, /<Status state=\{session\.state\} compact showLabel\/>/);
  assert.match(app, /<Button variant="primary" onClick=\{onNew\}><PlusIcon \/><span>New task<\/span><\/Button>/);
  assert.doesNotMatch(app, /<time>\{relativeTime\(session\.updatedAt\)\}<\/time><ChevronRightIcon \/>/);
  assert.match(styles, /\.card-heading \{[^}]*font-size:\s*11\.5px/);
  assert.match(styles, /\.recent-table strong \{[^}]*font-size:\s*13\.5px/);
  assert.match(styles, /@media \(max-height:\s*720px\)[\s\S]*?\.active-task-card, \.attention-card \{ min-height:\s*212px/);
  assert.match(styles, /@media \(max-width:\s*960px\)[\s\S]*?\.recent-table-head, \.recent-table > button \{ grid-template-columns:\s*minmax\(180px,1fr\) 90px 100px 45px/);
  assert.match(styles, /@media \(max-width:\s*900px\)[\s\S]*?\.dashboard-page \.page-heading \.button-primary \{ display:\s*none/);
  assert.match(styles, /@media \(max-width:\s*780px\)[\s\S]*?\.dashboard-page \.page-heading \.button-primary \{ display:\s*grid/);
  assert.match(styles, /\.page-heading \.button-primary \{[^}]*min-width:\s*164px;[^}]*min-height:\s*38px;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\);[^}]*font-size:\s*13px;[^}]*font-weight:\s*700/, "Dashboard New task uses the preferred top-left control proportion and independent label centring");
  assert.match(styles, /\.page-heading \.button-primary > svg \{[^}]*width:\s*17px;[^}]*height:\s*17px;[^}]*margin-right:\s*8px/);
});

test("task header protects title space and keeps secondary Open in choices in Task details", async () => {
  const [app, styles] = await Promise.all([source("App.tsx"), source("styles.css")]);
  assert.match(app, /className="task-details-open-in" role="group" aria-label="Open task folder in"/);
  assert.match(app, /localOpen\.state\.handlers\.map\(\(handler\) => <button/);
  assert.match(app, /<WorkspaceLocalOpenControl path=\{session\.workingDirectory\} \/>/);
  assert.match(styles, /\.workspace-header \{[^}]*container:\s*workspace-header \/ inline-size/);
  assert.match(styles, /\.context-usage-track \{[^}]*height:\s*7px/);
  assert.match(styles, /@container workspace-header \(max-width:\s*900px\)[\s\S]*?\.workspace-local-open-arrow \{ display:\s*none/);
  assert.match(styles, /@container workspace-header \(max-width:\s*720px\)[\s\S]*?\.context-usage-trigger \{ width:\s*122px[\s\S]*?\.workspace-actions \{ max-width:\s*192px/);
  assert.match(styles, /@media \(max-width:\s*780px\)[\s\S]*?\.context-usage-trigger \{ width:\s*122px/);
  assert.match(styles, /\.task-details-open-in button \{[^}]*min-height:\s*32px/);
});

test("reasoning, tool activity, and final answers share one assistant grid", async () => {
  const [composer, styles] = await Promise.all([source("composer.css"), source("styles.css")]);
  assert.match(composer, /\.conversation \{[^}]*--assistant-icon-column:\s*28px;[^}]*--assistant-column-gap:\s*9px;[^}]*--assistant-text-rail:/);
  assert.match(composer, /\.message-with-identity \.assistant-message-row \{[^}]*grid-template-columns:\s*var\(--assistant-icon-column\) minmax\(0,1fr\);[^}]*gap:\s*var\(--assistant-column-gap\)/);
  assert.match(composer, /\.message-without-identity \.assistant-message-row \{[^}]*padding-left:\s*var\(--assistant-text-rail\)/);
  assert.match(styles, /\.reasoning-disclosure \{[^}]*grid-template-columns:\s*var\(--assistant-icon-column,28px\) auto 13px;[^}]*column-gap:\s*var\(--assistant-column-gap,9px\)/);
  assert.match(styles, /\.activity-row \{[^}]*grid-template-columns:\s*var\(--assistant-icon-column,28px\) auto minmax\(0,1fr\) 14px;[^}]*column-gap:\s*var\(--assistant-column-gap,9px\)/);
  assert.match(styles, /\.activity-target \{[^}]*translate:\s*0 1px/);
  assert.match(styles, /\.reasoning-flow \{[^}]*margin:[^;}]*var\(--assistant-text-rail,37px\)/);
  assert.match(composer, /\.side-chat-transcript \{[^}]*--assistant-icon-column:\s*24px;[^}]*--assistant-column-gap:\s*7px;[^}]*--assistant-text-rail:\s*31px/);
  assert.match(composer, /\.side-chat-transcript \.message-with-identity \.assistant-message-row \{[^}]*grid-template-columns:\s*var\(--assistant-icon-column\) minmax\(0,1fr\);[^}]*gap:\s*var\(--assistant-column-gap\)/);
  assert.match(composer, /\.side-chat-transcript \.message-without-identity \.assistant-message-row \{[^}]*padding-left:\s*var\(--assistant-text-rail\)/);
});

test("all generic tooltips use one collision-aware body overlay", async () => {
  const [app, layer, styles] = await Promise.all([source("App.tsx"), source("TooltipLayer.tsx"), source("styles.css")]);
  assert.match(app, /<AppTooltipLayer \/>/);
  assert.match(layer, /const viewportInset = 8;/);
  assert.match(layer, /candidateCollides\(/);
  assert.match(layer, /document\.elementsFromPoint/);
  assert.match(layer, /new MutationObserver/);
  assert.match(layer, /createPortal\([\s\S]*document\.body/);
  assert.match(layer, /active\.target\.setAttribute\("aria-describedby"/);
  assert.match(styles, /\.app-tooltip-overlay \{[^}]*position:\s*fixed;[^}]*z-index:\s*2000/);
  assert.doesNotMatch(styles, /\[data-tooltip\]::after/);
  assert.match(styles, /\.titlebar:has\([^}]*\{ z-index:\s*410;/);
  assert.match(styles, /\.workspace-header \{[^}]*z-index:\s*60;/);
});
