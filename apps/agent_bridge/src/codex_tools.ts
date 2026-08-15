import { spawn } from "node:child_process";
import type { SessionMcpServer } from "../../../packages/provider_contract/src/index.js";
import { buildSpawnCommand, resolveCommand } from "../../../packages/provider_contract/src/index.js";

export async function installCodexMeshTools(server: SessionMcpServer, command = "codex"): Promise<void> {
  const existing = await runCodex(command, ["mcp", "get", server.name, "--json"]).catch(() => undefined);
  if (existing !== undefined) {
    try {
      const parsed = JSON.parse(existing.stdout) as {
        readonly transport?: { readonly command?: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> };
      };
      const transport = parsed.transport;
      if (transport?.command === server.command &&
        JSON.stringify(transport.args ?? []) === JSON.stringify(server.args) &&
        transport.env?.UAR_MESH_RUNTIME === server.env.UAR_MESH_RUNTIME) return;
    } catch {
      // Replace malformed or stale configuration below.
    }
    await runCodex(command, ["mcp", "remove", server.name]);
  }
  const stableEnvironment = server.env.UAR_MESH_RUNTIME === undefined ? server.env : { UAR_MESH_RUNTIME: server.env.UAR_MESH_RUNTIME };
  const environmentArgs = Object.entries(stableEnvironment).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  await runCodex(command, ["mcp", "add", server.name, ...environmentArgs, "--", server.command, ...server.args]);
}

function runCodex(command: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const resolved = resolveCommand(command);
  const launch = buildSpawnCommand(resolved, args);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args], {
      ...(launch.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Codex MCP configuration command failed (${code ?? "terminated"}): ${stderr.trim()}`));
    });
  });
}
