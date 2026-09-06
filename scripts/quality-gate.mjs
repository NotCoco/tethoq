import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const ignoredDirectories = new Set([
  ".dart_tool", ".example-dist", ".git", ".next", ".playwright-cli", ".runtime", ".test-dist", ".tmp-appserver-schema",
  "artifacts", "build", "coverage", "dist", "local-artifacts", "node_modules", "out", "release", "tmp", "work",
]);
const ignoredDirectoryPrefixes = ["qa-artifacts", "release-"];
const sourceExtensions = new Set([".ts", ".tsx", ".cts", ".mts", ".dart", ".js", ".jsx", ".cjs", ".mjs"]);
const suspicious = [
  /throw new Error\(["']Not implemented["']\)/i,
  /\bFIXME\b/,
  /(?:password|api[_-]?key|secret)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i,
];
const reviewedWords = /\b(?:TODO|placeholder|mocked|unimplemented)\b/i;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && (
      ignoredDirectories.has(entry.name)
      || ignoredDirectoryPrefixes.some((prefix) => entry.name.startsWith(prefix))
    )) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

const rootPath = fileURLToPath(root);
const files = await walk(rootPath);
const failures = [];
const review = [];
let scannedFiles = 0;
for (const path of files) {
  if (!sourceExtensions.has(extname(path))) continue;
  scannedFiles += 1;
  const text = await readFile(path, "utf8");
  for (const pattern of suspicious) {
    if (pattern.test(text)) failures.push(`${relative(rootPath, path)} matches ${pattern}`);
  }
  if (reviewedWords.test(text)) review.push(relative(rootPath, path));
}

if (review.length) {
  console.log(`Reviewed quality-keyword occurrences in: ${review.join(", ")}`);
}
if (failures.length) {
  console.error("Quality gate failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Quality gate passed across ${scannedFiles} source files.`);
}
