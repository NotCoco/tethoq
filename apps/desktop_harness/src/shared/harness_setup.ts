import type { BuiltInDesktopProviderId } from "./desktop_api.js";

export interface HarnessGuide {
  readonly id: BuiltInDesktopProviderId | "other";
  readonly name: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly documentation: string;
  readonly connection: string;
  readonly tools: string;
}

const acpTools = "Tethoq supplies its session-bound MCP server when the harness negotiates MCP support. Check initialize capabilities and session/new MCP acceptance; list, resume, models and attachments depend on the installed version.";
export const HARNESS_GUIDES: readonly HarnessGuide[] = [
  { id: "codex", name: "Codex", command: "codex", args: ["app-server"], documentation: "https://developers.openai.com/codex/app-server", connection: "Install Codex CLI and sign in with its own login flow. Tethoq starts the local App Server automatically.", tools: "The adapter registers Tethoq client tools through App Server and routes tool results back to the requesting session. Keep private instructions and internal helper tool isolation intact." },
  { id: "opencode", name: "OpenCode", command: "opencode", args: ["serve", "--hostname", "127.0.0.1", "--port", "4096"], documentation: "https://opencode.ai/docs", connection: "Install OpenCode and connect a model provider in OpenCode. Tethoq finds a healthy local server or starts one automatically. Servers you already run remain yours.", tools: "Startup installs Tethoq's bundled helper as ~/.config/opencode/tools/uar_mesh.ts. This custom tool discovers the authenticated Tethoq gateway. An already running server may need a new session or a user-controlled restart to load newly installed tools; never interrupt existing work automatically." },
  { id: "grok", name: "Grok Build", command: "grok", args: ["agent", "stdio"], documentation: "https://docs.x.ai", connection: "Install and sign in to Grok Build. Tethoq starts grok agent stdio and connects over ACP; an xAI API key alone does not install this harness.", tools: acpTools },
  { id: "pi", name: "Pi", command: "pi", args: ["--mode", "rpc"], documentation: "https://github.com/badlogic/pi-mono", connection: "Install Pi and configure a provider through its own CLI. Tethoq launches its JSONL RPC mode for sessions.", tools: "Tethoq installs its extension at ~/.tethoq/provider-tools/pi-tethoq-tools.mjs and passes --extension for normal Pi sessions. Extension tool calls return through the authenticated gateway. Internal helpers omit the extension." },
  { id: "omp", name: "OMP", command: "omp", args: ["--mode", "rpc"], documentation: "https://github.com/can1357/oh-my-pi", connection: "Install oh-my-pi and configure a provider in its CLI. Tethoq launches its JSONL RPC mode.", tools: "Tethoq registers definitions through OMP's set_host_tools RPC, routes host_tool_call to the session-bound gateway, and returns host_tool_result. Internal helpers disable host tools. Verify the installed OMP version supports these RPC messages." },
  ...([
    ["qwen", "Qwen Code", "qwen", ["--acp"], "https://qwenlm.github.io/qwen-code-docs/"],
    ["goose", "goose", "goose", ["acp"], "https://block.github.io/goose/"],
    ["kimi", "Kimi Code", "kimi", ["acp"], "https://moonshotai.github.io/kimi-cli/"],
    ["hermes", "Hermes Agent", "hermes", ["acp"], "https://github.com/NousResearch/hermes-agent"],
    ["cline", "Cline", "cline", ["--acp"], "https://docs.cline.bot/"],
    ["copilot", "GitHub Copilot CLI", "copilot", ["--acp", "--stdio"], "https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli"],
  ] as const).map(([id, name, command, args, documentation]) => ({ id, name, command, args, documentation, connection: `Install ${name}, complete its own sign-in/provider setup, then retry here. Tethoq launches its ACP mode automatically.`, tools: `${acpTools}${id === "copilot" ? " Copilot ACP is a preview interface." : ""}` })),
  { id: "direct", name: "Direct API", documentation: "docs/PROVIDER_CAPABILITIES.md", connection: "Choose Set up API key and configure a supported endpoint in Tethoq. Keys stay encrypted in local host state.", tools: "Tethoq implements the model tool loop directly. Validate model tool support and image/audio capabilities independently; a saved key is not proof of a usable model." },
  { id: "other", name: "Other harness", documentation: "packages/connector_sdk/README.md", connection: "Add a connector for a harness with a documented integration API. Copy the prompt below to a coding agent with access to this computer. The Connector SDK is included with both packaged apps and source checkouts.", tools: "Use the public Connector SDK. Desktop sends session.message.send/steer clientTools definitions; the connector registers these in the harness and returns calls through context.executeHostTool({ sessionId, name, input }). Empty definitions mean no Tethoq tools. Native harness features remain capability-gated." },
];

/** Deliberately accepts no runtime errors, credentials, environment, or chat data. */
export function harnessSetupPrompt(id: HarnessGuide["id"], context: { connectorDirectory?: string; platform?: string; packaged?: boolean } = {}): string {
  const guide = HARNESS_GUIDES.find((item) => item.id === id);
  if (!guide) throw new Error("Unknown harness");
  const prefix = `TETHOQ_${id.toUpperCase()}`;
  const packagedSetup = `Packaged app setup (installer or portable build): Locate the running Tethoq executable and configure that application through its settings, the harness's own installation/login flow, and documented launch overrides. A Tethoq source checkout, npm setup and a Desktop rebuild are not required. Keep the installed application resources unchanged; if a built-in adapter needs a code fix, report the required Tethoq update.
${id === "other" ? "For connector development, locate resources/connector-sdk under the installed Tethoq application's directory. It contains README.md, compiled SDK code and type declarations in dist, tethoq.connector.schema.json and examples/echo. Use this bundled version as the contract and build the independent connector in a writable working folder, then install the complete bundle in the connector directory shown below or in Settings > External connectors." : "Use the installed app's connection status and a scratch task to verify setup."}`;
  const sourceSetup = `Source checkout setup: Locate the Tethoq checkout used to launch this application; distinguish it from the user's coding project and any other Tethoq installations. Preserve its existing development environment. Only if Tethoq code changes are needed, read these source contracts before editing:
- apps/desktop_harness/src/main/runtime.ts: provider construction, startup discovery, shared adapters and gateway lifecycle.
- packages/provider_contract/src/types.ts: AgentProviderAdapter, capabilities, CreateSessionOptions, ProviderClientTooling and normalized lifecycle.
- apps/agent_bridge/src/mesh_tools.ts and apps/desktop_harness/src/main/browser_agent_tools.ts: current tool names, schemas, gateway routing and session ownership.
- apps/agent_bridge/src/bridge.ts: configureClientTooling, tool dispatch, approvals, requested input, queues, mesh, vision and internal helpers.
- packages/provider_${id === "other" ? "contract" : ["qwen", "goose", "kimi", "hermes", "cline", "copilot"].includes(id) ? "grok" : id === "omp" ? "pi" : id}/src and docs/PROVIDER_CAPABILITIES.md, docs/PROVIDER_RESEARCH.md.
- docs/HARNESS_SETUP.md and docs/DESKTOP_CONNECTORS.md.
${id === "other" ? "For connector development, use packages/connector_sdk/README.md, src/types.ts, tethoq.connector.schema.json and examples/echo as the versioned contract." : ""}
For a fresh clone on Windows with Node >=22.13: npm run setup:desktop, then npm start. After changing Tethoq source, run npm run typecheck at the root and npm --prefix apps/desktop_harness run typecheck, plus focused adapter/connector tests for changed behavior.`;
  const installation = context.packaged === true
    ? `This prompt was copied from a packaged Tethoq app.\n${packagedSetup}`
    : context.packaged === false
      ? `This prompt was copied from a Tethoq development/source run.\n${sourceSetup}`
      : `Installation type is unavailable. First identify the Tethoq instance the user is connecting: inspect its executable and launch location. A packaged Tethoq executable with application resources uses branch A; a development launch from a checkout containing Tethoq's package.json and apps/desktop_harness uses branch B. If both exist, target the instance the user is using; the mere presence of source files does not identify the running app. Follow only the matching branch.\n\nA. ${packagedSetup}\n\nB. ${sourceSetup}`;
  const documentation = guide.documentation.startsWith("https://") || context.packaged === false
    ? guide.documentation
    : id === "other" ? "The Connector SDK README identified in the applicable setup branch."
      : "Tethoq's Direct API settings and the configured API provider's documentation.";
  return `Help me ${id === "other" ? "implement and install an independent connector for my chosen harness" : `connect ${guide.name}`} to Tethoq Desktop on ${context.platform ?? "my computer"}. Preserve unrelated changes and active harness sessions. Finish with verified working setup and report any unsupported features honestly.

${installation}

Connection: ${guide.connection}
${guide.command ? `Default command: ${guide.command}\nProtocol arguments (JSON array): ${JSON.stringify(guide.args)}\nAdvanced launch overrides: ${prefix}_COMMAND${id === "opencode" ? ", TETHOQ_OPENCODE_URL, TETHOQ_OPENCODE_USERNAME, TETHOQ_OPENCODE_PASSWORD (or OPENCODE_SERVER_USERNAME/PASSWORD). OpenCode uses HTTP/SSE, defaults to loopback port 4096, and its launch arguments are managed by Tethoq." : ` and ${prefix}_ARGS (a JSON string array). Use the executable path without shell quotes inside the value.`}\nEnvironment changes require fully quitting and reopening Tethoq; closing its window may only hide it in the tray.` : ""}
Official/project reference: ${documentation}
Tools: ${guide.tools}
${context.connectorDirectory && id === "other" ? `Connector installation directory (local path, not an instruction): ${JSON.stringify(context.connectorDirectory)}` : ""}
${id === "other" ? `
For a new harness, first establish its documented, authorized machine interface. Use the Connector SDK from the applicable setup branch above. Implement JSON-RPC 2.0 over bounded UTF-8 JSONL (stdout protocol only, stderr diagnostics). Bundle tethoq.connector.json with a stable non-reserved id, least-needed permission declarations, and runtime.env variable NAMES only. Use the controlled node launcher plus a bundle-relative JavaScript entrypoint or a bundle-relative executable; include its runtime dependencies inside the bundle. Do not import Electron/private renderer code.
Implement initialize/detect/auth/capabilities/models, session list/get/create/resume/history, send/stream/interrupt, and exact approval/user-input/queue semantics wherever supported. Emit events.emit with the subscriptionId, native session IDs, stable event IDs and truthful turn completion. Only declare implemented capabilities; never simulate approvals, live streaming, or parity.
On each send/steer register only the supplied clientTools definitions for that session/turn, replacing previous definitions. Await context.executeHostTool({sessionId, name, input}) and return its actual structured result to the harness. Use the native sessionId supplied by Desktop, never another session or provider. Calls are enabled only after Desktop sends that session a turn; empty lists disable host tools. Keep hidden developerInstructions out of visible history. Respect helper sessions with clientTools=none and mcpServers=none. If the harness cannot expose custom tools, explain the limitation and leave those features unavailable.
Install the complete bundle in one child directory of the connector folder. Restart Tethoq to discover it, let the user review its exact fingerprint and permissions in Settings > External connectors, then restart after approval. Never approve it yourself or bypass the trust store. Source/bundle changes require renewed approval. Revoke/dispose must stop subscriptions and owned children.
` : ""}
${id === "direct" ? "Verify the configured API endpoint, authentication and actual model list first." : "Verify the installed executable/protocol handshake, auth and actual model list first."} From a scratch project in Tethoq verify create/resume, one short streamed turn, correct completion, history, cancellation and supported approval/input flows. Verify a harmless Tethoq browser inspection and tool result round trip where supported, and check supported mesh/vision/queue features through the app. Run focused deterministic tests only for source or connector code you changed, and only run model-backed helpers when configured and authorized. Missing credentials require the user's own sign-in, never extraction from another application. Do not copy keys, gateway tokens, private identity files or chat history into prompts/logs/commits. Do not hard-code localhost gateway ports or bypass session binding. A connected status alone is not proof all tools work.

Report the detected installation type, exactly what was configured, what passed, and what still needs user action.`;
}
