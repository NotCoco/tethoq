import { readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const output = new URL("../.test-dist/", import.meta.url);
await rm(output, { recursive: true, force: true });

await run(process.execPath, ["../../node_modules/typescript/bin/tsc", "-p", "tsconfig.test.json"]);
const tests = await walk(join(dirname(fileURLToPath(import.meta.url)), "..", ".test-dist", "src"));
if (tests.length === 0) throw new Error("No compiled connector SDK tests were found");
await run(process.execPath, ["--test", ...tests.sort()]);

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else if (entry.name.endsWith(".test.js")) output.push(path);
  }
  return output;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: new URL("../", import.meta.url), stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Command failed (${signal ?? code}): ${command} ${args.join(" ")}`)));
  });
}
