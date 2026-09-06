import type { JsonObject } from "../../protocol/src/index.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpawnCommand, resolveCommand } from "../../provider_contract/src/index.js";

export interface CodexVisionCatalog {
  readonly path: string;
  dispose(): Promise<void>;
}

export async function prepareCodexVisionCatalog(command: string, modelId: string | undefined, config: Record<string, unknown>, environment: NodeJS.ProcessEnv): Promise<CodexVisionCatalog> {
  const source = typeof config.model_catalog_json === "string"
    ? await readFile(config.model_catalog_json, "utf8")
    : await new Promise<string>((resolve, reject) => {
      const spawn = buildSpawnCommand(resolveCommand(command, { env: environment }), ["debug", "models", "--bundled"]);
      execFile(spawn.command, [...spawn.args], { env: environment, windowsHide: true, windowsVerbatimArguments: spawn.windowsVerbatimArguments === true, timeout: 15_000, maxBuffer: 8_000_000, encoding: "utf8" }, (error, stdout) => {
        if (error) reject(new Error("Codex cannot provide the model metadata needed for stripped-down EYES"));
        else resolve(stdout);
      });
    });
  const catalog = JSON.parse(source) as { models?: Array<Record<string, unknown>> };
  const model = catalog.models?.find((entry) => entry.slug === modelId);
  if (model === undefined) throw new Error("The selected Codex model has no metadata for stripped-down EYES");
  const directory = await mkdtemp(join(tmpdir(), "tethoq-eyes-codex-"));
  const path = join(directory, "models.json");
  const dispose = async () => { await rm(path, { force: true }); await rmdir(directory); };
  try {
    // Keep the exact model and its capabilities. Only its coding-tool defaults
    // change. New Codex models otherwise force Code Mode despite feature flags.
    await writeFile(path, JSON.stringify({ models: [{
      ...model,
      tool_mode: null,
      node_repl_disabled: true,
      apply_patch_tool_type: null,
      experimental_supported_tools: [],
    }] }), "utf8");
    return { path, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Per-thread overrides only; never change the user's normal Codex configuration. */
export function codexVisionIsolationConfig(effectiveConfig: Record<string, unknown>): JsonObject {
  const servers = effectiveConfig.mcp_servers;
  const serverNames = typeof servers === "object" && servers !== null && !Array.isArray(servers)
    ? Object.keys(servers) : [];
  return {
    // Empty tables merge with inherited configuration. Disable each server
    // explicitly so a helper cannot start another copy of its process.
    mcp_servers: Object.fromEntries(serverNames.map((name) => [name, { enabled: false, required: false }])),
    web_search: "disabled",
    developer_instructions: "",
    include_permissions_instructions: false,
    include_collaboration_mode_instructions: false,
    include_apps_instructions: false,
    project_doc_max_bytes: 0,
    skills: { bundled: { enabled: false }, include_instructions: false },
    agents: { enabled: false },
    tools: { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } },
    features: {
      shell_tool: false,
      unified_exec: false,
      shell_snapshot: false,
      apply_patch_freeform: false,
      js_repl: false,
      js_repl_tools_only: false,
      code_mode: false,
      code_mode_only: false,
      code_mode_host: false,
      code_mode_prewarm: false,
      view_image: false,
      image_generation: false,
      imagegenext: false,
      apps: false,
      plugins: false,
      remote_plugin: false,
      hooks: false,
      codex_hooks: false,
      plugin_hooks: false,
      multi_agent: false,
      enable_fanout: false,
      multi_agent_v2: false,
      goals: false,
      memories: false,
      memory_tool: false,
      browser_use: false,
      browser_use_external: false,
      in_app_browser: false,
      computer_use: false,
      tool_search: false,
      tool_suggest: false,
      search_tool: false,
      skill_search: false,
      skill_mcp_dependency_install: false,
      skip_host_skill_discovery: true,
      request_permissions: false,
      request_permissions_tool: false,
      default_mode_request_user_input: false,
    },
  };
}
