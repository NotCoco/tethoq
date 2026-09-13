import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface OpenCodeMeshToolInstallOptions {
  readonly userHome?: string;
  readonly targetPath?: string;
  readonly sourcePath?: string;
}

export function openCodeMeshToolPath(userHome = homedir()): string {
  return join(userHome, ".config", "opencode", "tools", "uar_mesh.ts");
}

export async function installOpenCodeMeshTools(options: OpenCodeMeshToolInstallOptions = {}): Promise<void> {
  const source = await resolveOpenCodeMeshToolSource(options.sourcePath);
  const target = options.targetPath ?? openCodeMeshToolPath(options.userHome);
  const expected = await readFile(source, "utf8");
  try {
    if (await readFile(target, "utf8") === expected) return;
  } catch {
    // Install below.
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, expected, "utf8");
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function installOpenCodeImagePolicy(options: OpenCodeMeshToolInstallOptions = {}): Promise<void> {
  const source = await resolveOpenCodeMeshToolSource(options.sourcePath, "tethoq_images.txt");
  const implementation = join(options.userHome ?? homedir(), ".config", "opencode", "tethoq_images.mjs");
  await installOpenCodeMeshTools({
    sourcePath: source,
    targetPath: implementation,
  });
  // Bun caches file imports across instance disposal. This stable loader reads
  // the current implementation on each new instance and imports it by content.
  const target = options.targetPath ?? join(options.userHome ?? homedir(), ".config", "opencode", "plugins", "tethoq_images.js");
  // Keep generated import statements in quoted lines: electron-vite's CommonJS
  // shim scanner otherwise mistakes imports inside a multiline template for
  // the containing application's imports and injects its shim into the loader.
  const loader = [
    'import { readFile } from "node:fs/promises";',
    'import { createHash } from "node:crypto";',
    'export default async (input, options) => {',
    `  const source = await readFile(${JSON.stringify(implementation)}, "utf8");`,
    '  const loaded = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));',
    '  return loaded.default(input, { ...options, revision: createHash("sha256").update(source).digest("hex") });',
    '};',
    '',
  ].join("\n");
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, loader); await rename(temporary, target); }
  finally { await unlink(temporary).catch(() => undefined); }
}

async function resolveOpenCodeMeshToolSource(explicitPath: string | undefined, name = "uar_mesh.txt"): Promise<string> {
  const candidates = [
    explicitPath,
    fileURLToPath(new URL(`../assets/opencode/${name}`, import.meta.url)),
    fileURLToPath(new URL(`../../../../apps/agent_bridge/assets/opencode/${name}`, import.meta.url)),
  ].filter((value): value is string => value !== undefined);
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("The bundled OpenCode tool asset is missing");
}
