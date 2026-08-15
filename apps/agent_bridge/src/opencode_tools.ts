import { copyFile, mkdir, readFile } from "node:fs/promises";
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
  await copyFile(source, target);
}

async function resolveOpenCodeMeshToolSource(explicitPath: string | undefined): Promise<string> {
  const candidates = [
    explicitPath,
    fileURLToPath(new URL("../assets/opencode/uar_mesh.txt", import.meta.url)),
    fileURLToPath(new URL("../../../../apps/agent_bridge/assets/opencode/uar_mesh.txt", import.meta.url)),
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
