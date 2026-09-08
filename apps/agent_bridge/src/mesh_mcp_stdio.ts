import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { isJsonObject, type JsonObject } from "../../../packages/protocol/src/index.js";
import { callMeshToolGateway } from "./mesh_tools.js";

const runtime = await runtimeConnection();
const pipePath = runtime.pipePath;
const token = runtime.token;
const boundParentSessionId = process.env.UAR_MESH_PARENT_SESSION_ID;
const bindingId = process.env.UAR_MESH_BINDING_ID;
const lifecycleOwner = process.env.UAR_MESH_CLIENT_TOOL_LIFECYCLE_OWNER === "provider" ? "provider" : "bridge";
const server = new McpServer({ name: "uar-mesh", version: "0.1.0" });

server.registerTool("mesh_list_sessions", {
  title: "Find Tethoq tasks",
  description: "Find other indexed Tethoq tasks on this host without scanning folders or session databases.",
  inputSchema: {
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(25).optional(),
    parent_session_id: z.string().optional(),
  },
}, async ({ query, limit, parent_session_id }) => result(await call(parent_session_id, "mesh_list_sessions", {
  ...(query !== undefined ? { query } : {}),
  ...(limit !== undefined ? { limit } : {}),
})));

server.registerTool("mesh_message_session", {
  title: "Message Tethoq task",
  description: "Send a message to another indexed Tethoq task. Steers active work when supported or waits for idle; queued user messages run first.",
  inputSchema: {
    target_session_id: z.string().min(1).max(16_384),
    message: z.string().min(1).max(32_000),
    request_id: z.string().min(1).max(256),
    parent_session_id: z.string().optional(),
  },
}, async ({ target_session_id, message, request_id, parent_session_id }) => result(await call(parent_session_id, "mesh_message_session", {
  target_session_id, message, request_id,
})));

server.registerTool("mesh_dispatch_delegation", {
  title: "Dispatch prepared Mesh delegation",
  description: "Dispatch every pre-authorized target for this turn using parent-authored instructions. Provider, model, and reasoning choices cannot be supplied or changed here.",
  inputSchema: {
    delegation_id: z.string().min(1).max(256),
    assignments: z.array(z.object({
      target_index: z.number().int().min(0).max(3),
      instruction: z.string().min(1).max(32_000),
    }).strict()).min(1).max(4),
    parent_session_id: z.string().optional(),
  },
}, async ({ delegation_id, assignments, parent_session_id }) => result(await call(
  parent_session_id,
  "mesh_dispatch_delegation",
  { delegation_id, assignments },
)));

server.registerTool("mesh_list_children", {
  title: "List delegated children",
  description: "List the cross-harness child sessions delegated by this parent, including stable IDs and live states.",
  inputSchema: { parent_session_id: z.string().optional() },
}, async ({ parent_session_id }) => result(await call(parent_session_id, "mesh_list_children", {})));

server.registerTool("mesh_message_child", {
  title: "Message delegated child",
  description: "Send a follow-up instruction to an existing cross-harness child session.",
  inputSchema: {
    child_session_id: z.string().min(1),
    message: z.string().min(1),
    parent_session_id: z.string().optional(),
  },
}, async ({ child_session_id, message, parent_session_id }) => result(await call(parent_session_id, "mesh_message_child", { child_session_id, message })));

server.registerTool("mesh_wait", {
  title: "Wait for delegated children",
  description: "Wait until selected delegated children stop working, need attention, or the timeout expires.",
  inputSchema: {
    child_session_ids: z.array(z.string().min(1)).optional(),
    timeout_seconds: z.number().int().min(1).max(900).optional(),
    parent_session_id: z.string().optional(),
  },
}, async ({ child_session_ids, timeout_seconds, parent_session_id }) => result(await call(parent_session_id, "mesh_wait", {
  ...(child_session_ids !== undefined ? { child_session_ids } : {}),
  ...(timeout_seconds !== undefined ? { timeout_seconds } : {}),
})));

server.registerTool("mesh_read_result", {
  title: "Read delegated result",
  description: "Read the latest assistant result and recent transcript tail from one delegated child session.",
  inputSchema: { child_session_id: z.string().min(1), parent_session_id: z.string().optional() },
}, async ({ child_session_id, parent_session_id }) => result(await call(parent_session_id, "mesh_read_result", { child_session_id })));

server.registerTool("tethoq_turn_support", {
  title: "Tethoq turn support",
  description: "Use only when private turn-scoped Tethoq guidance explicitly instructs you to call this tool. Do not infer a purpose or call it without that guidance.",
  inputSchema: { request: z.string().min(1).max(8_000), parent_session_id: z.string().optional() },
}, async ({ request: turnRequest, parent_session_id }, request) => result(await call(
  parent_session_id,
  "tethoq_turn_support",
  { request: turnRequest },
  { callId: String(request.requestId), lifecycleOwner },
)));

server.registerTool("browser_get_state", {
  title: "Get browser state",
  description: "Read tab, loading, navigation and audio state plus bounded visible text and semantic controls from the active page.",
  inputSchema: { parent_session_id: z.string().optional() },
}, async ({ parent_session_id }) => result(await call(parent_session_id, "browser_get_state", {})));

server.registerTool("browser_open", {
  title: "Open browser tab",
  description: "Open an HTTP(S) address or web search in a new background tab without changing the user's selected tab.",
  inputSchema: { url_or_search: z.string().min(1).max(8_192), activate: z.boolean().optional(), parent_session_id: z.string().optional() },
}, async ({ url_or_search, activate, parent_session_id }) => result(await call(parent_session_id, "browser_open", {
  url_or_search, ...(activate !== undefined ? { activate } : {}),
})));

server.registerTool("browser_navigate", {
  title: "Navigate browser tab",
  description: "Navigate a Tethoq browser tab to an HTTP(S) address or web search.",
  inputSchema: { tab_id: z.string().optional(), url_or_search: z.string().min(1).max(8_192), parent_session_id: z.string().optional() },
}, async ({ tab_id, url_or_search, parent_session_id }) => result(await call(parent_session_id, "browser_navigate", {
  ...(tab_id !== undefined ? { tab_id } : {}), url_or_search,
})));

server.registerTool("browser_inspect", {
  title: "Inspect browser page",
  description: "Read bounded visible text and semantic references for visible page controls.",
  inputSchema: { tab_id: z.string().optional(), parent_session_id: z.string().optional() },
}, async ({ tab_id, parent_session_id }) => result(await call(parent_session_id, "browser_inspect", {
  ...(tab_id !== undefined ? { tab_id } : {}),
})));

server.registerTool("browser_inspect_all", {
  title: "Inspect all browser pages",
  description: "Read bounded visible text and semantic controls from every browser tab.",
  inputSchema: { max_text_per_tab: z.number().int().min(250).max(20_000).optional(), parent_session_id: z.string().optional() },
}, async ({ max_text_per_tab, parent_session_id }) => result(await call(parent_session_id, "browser_inspect_all", {
  ...(max_text_per_tab !== undefined ? { max_text_per_tab } : {}),
})));

server.registerTool("browser_click", {
  title: "Click browser control",
  description: "Click one semantic reference returned by browser_inspect.",
  inputSchema: { tab_id: z.string().optional(), ref: z.string().min(1).max(100), parent_session_id: z.string().optional() },
}, async ({ tab_id, ref, parent_session_id }) => result(await call(parent_session_id, "browser_click", {
  ...(tab_id !== undefined ? { tab_id } : {}), ref,
})));

server.registerTool("browser_type", {
  title: "Type in browser field",
  description: "Replace the contents of a safe semantic text-field reference.",
  inputSchema: { tab_id: z.string().optional(), ref: z.string().min(1).max(100), text: z.string().max(20_000), submit: z.boolean().optional(), parent_session_id: z.string().optional() },
}, async ({ tab_id, ref, text, submit, parent_session_id }) => result(await call(parent_session_id, "browser_type", {
  ...(tab_id !== undefined ? { tab_id } : {}), ref, text, ...(submit !== undefined ? { submit } : {}),
})));

server.registerTool("browser_scroll", {
  title: "Scroll browser page",
  description: "Scroll a Tethoq browser page by bounded pixel deltas.",
  inputSchema: { tab_id: z.string().optional(), delta_x: z.number().int().min(-4_000).max(4_000).optional(), delta_y: z.number().int().min(-4_000).max(4_000).optional(), parent_session_id: z.string().optional() },
}, async ({ tab_id, delta_x, delta_y, parent_session_id }) => result(await call(parent_session_id, "browser_scroll", {
  ...(tab_id !== undefined ? { tab_id } : {}), ...(delta_x !== undefined ? { delta_x } : {}), ...(delta_y !== undefined ? { delta_y } : {}),
})));

server.registerTool("browser_capture", {
  title: "Inspect browser visually",
  description: "Capture the visible browser page and ask the configured visual-support model a focused question.",
  inputSchema: { tab_id: z.string().optional(), question: z.string().min(1).max(2_000).optional(), parent_session_id: z.string().optional() },
}, async ({ tab_id, question, parent_session_id }) => result(await call(parent_session_id, "browser_capture", {
  ...(tab_id !== undefined ? { tab_id } : {}), ...(question !== undefined ? { question } : {}),
})));

server.registerTool("browser_activate", {
  title: "Activate browser tab",
  description: "Make a browser tab active.",
  inputSchema: { tab_id: z.string().min(1).max(100), parent_session_id: z.string().optional() },
}, async ({ tab_id, parent_session_id }) => result(await call(parent_session_id, "browser_activate", { tab_id })));

server.registerTool("browser_close", {
  title: "Close browser tab",
  description: "Close a browser tab.",
  inputSchema: { tab_id: z.string().min(1).max(100), parent_session_id: z.string().optional() },
}, async ({ tab_id, parent_session_id }) => result(await call(parent_session_id, "browser_close", { tab_id })));

server.registerTool("browser_back", {
  title: "Browser back",
  description: "Go back in a browser tab's history.",
  inputSchema: { tab_id: z.string().optional(), parent_session_id: z.string().optional() },
}, async ({ tab_id, parent_session_id }) => result(await call(parent_session_id, "browser_back", {
  ...(tab_id !== undefined ? { tab_id } : {}),
})));

server.registerTool("browser_forward", {
  title: "Browser forward",
  description: "Go forward in a browser tab's history.",
  inputSchema: { tab_id: z.string().optional(), parent_session_id: z.string().optional() },
}, async ({ tab_id, parent_session_id }) => result(await call(parent_session_id, "browser_forward", {
  ...(tab_id !== undefined ? { tab_id } : {}),
})));

server.registerTool("browser_reload", {
  title: "Reload browser tab",
  description: "Reload a browser tab.",
  inputSchema: { tab_id: z.string().optional(), parent_session_id: z.string().optional() },
}, async ({ tab_id, parent_session_id }) => result(await call(parent_session_id, "browser_reload", {
  ...(tab_id !== undefined ? { tab_id } : {}),
})));

server.registerTool("browser_stop", {
  title: "Stop browser loading",
  description: "Stop loading a browser tab.",
  inputSchema: { tab_id: z.string().optional(), parent_session_id: z.string().optional() },
}, async ({ tab_id, parent_session_id }) => result(await call(parent_session_id, "browser_stop", {
  ...(tab_id !== undefined ? { tab_id } : {}),
})));

server.registerTool("browser_set_muted", {
  title: "Mute browser tab",
  description: "Mute or unmute audio in a browser tab.",
  inputSchema: { tab_id: z.string().optional(), muted: z.boolean().optional(), parent_session_id: z.string().optional() },
}, async ({ tab_id, muted, parent_session_id }) => result(await call(parent_session_id, "browser_set_muted", {
  ...(tab_id !== undefined ? { tab_id } : {}), ...(muted !== undefined ? { muted } : {}),
})));

await server.connect(new StdioServerTransport());

async function call(
  parentSessionId: string | undefined,
  tool: string,
  input: JsonObject,
  context?: { readonly callId?: string; readonly lifecycleOwner?: "bridge" | "provider" },
) {
  if (bindingId !== undefined && bindingId.length > 0) {
    return await callMeshToolGateway(pipePath, token, undefined, tool, input, bindingId, context);
  }
  if (tool === "mesh_message_session" && boundParentSessionId === undefined) {
    throw new Error("Cross-task messaging requires a Tethoq session-bound tool connection");
  }
  const resolvedParent = boundParentSessionId ?? parentSessionId;
  if (resolvedParent === undefined || resolvedParent.length === 0) throw new Error("parent_session_id is required for this shared mesh tool server");
  return await callMeshToolGateway(pipePath, token, resolvedParent, tool, input, undefined, context);
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isJsonObject(value) ? { structuredContent: value } : {}),
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function runtimeConnection(): Promise<{ readonly pipePath: string; readonly token: string }> {
  const explicitPipe = process.env.UAR_MESH_PIPE;
  const explicitToken = process.env.UAR_MESH_TOKEN;
  if (explicitPipe !== undefined && explicitPipe.length > 0 && explicitToken !== undefined && explicitToken.length > 0) {
    return { pipePath: explicitPipe, token: explicitToken };
  }
  const path = process.env.UAR_MESH_RUNTIME;
  if (path !== undefined && path.length > 0) {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { readonly pipePath?: unknown; readonly token?: unknown };
    if (typeof parsed.pipePath === "string" && typeof parsed.token === "string") return { pipePath: parsed.pipePath, token: parsed.token };
  }
  return { pipePath: requiredEnvironment("UAR_MESH_PIPE"), token: requiredEnvironment("UAR_MESH_TOKEN") };
}
