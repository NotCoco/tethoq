import { rm, cp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = join(root, ".example-dist");
await rm(temp, { recursive: true, force: true });
await run(process.execPath, ["../../node_modules/typescript/bin/tsc", "-p", "tsconfig.example.json"]);
const compiled = join(temp, "examples", "echo", "connector.js");
const target = join(root, "examples", "echo", "connector.js");
await cp(compiled, target);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Example build failed (${signal ?? code})`)));
  });
}
