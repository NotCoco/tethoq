import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.name.endsWith(".test.js")) files.push(path);
  }
  return files;
}

const tests = (await walk(dist)).sort();
if (tests.length === 0) {
  console.error("No compiled .test.js files found under dist.");
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ["--test", ...tests], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) console.error(`test runner terminated by ${signal}`);
    process.exitCode = code ?? 1;
  });
}
