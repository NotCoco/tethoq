import { copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PiToolInstallOptions {
  readonly userHome?: string;
  readonly targetPath?: string;
  readonly sourcePath?: string;
}

export function piToolExtensionPath(userHome = homedir()): string {
  return join(userHome, ".tethoq", "provider-tools", "pi-tethoq-tools.mjs");
}

export async function installPiTools(options: PiToolInstallOptions = {}): Promise<void> {
  const source = await resolvePiToolSource(options.sourcePath);
  const target = options.targetPath ?? piToolExtensionPath(options.userHome);
  const expected = await readFile(source, "utf8");
  try {
    if (await readFile(target, "utf8") === expected) return;
  } catch {
    // Install below.
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function resolvePiToolSource(explicitPath: string | undefined): Promise<string> {
  const candidates = [
    explicitPath,
    fileURLToPath(new URL("../assets/pi/tethoq_tools.txt", import.meta.url)),
    fileURLToPath(new URL("../../../../apps/agent_bridge/assets/pi/tethoq_tools.txt", import.meta.url)),
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
  throw lastError ?? new Error("The bundled Pi tool asset is missing");
}
