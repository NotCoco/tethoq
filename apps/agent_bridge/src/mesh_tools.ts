import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
  type ClientToolDefinition,
  type ProviderClientTooling,
  type SessionMcpBinding,
  type SessionMcpServer,
} from "../../../packages/provider_contract/src/index.js";
import { isJsonObject, makeGlobalSessionId, type JsonObject, type JsonValue } from "../../../packages/protocol/src/index.js";

export type MeshToolExecutor = (
  parentSessionId: string,
  tool: string,
  input: JsonObject,
) => Promise<JsonValue>;

interface GatewayRequest {
  readonly token: string;
  readonly parentSessionId?: string;
  readonly bindingId?: string;
  readonly tool: string;
  readonly input: JsonObject;
}

interface GatewayResponse {
  readonly ok: boolean;
  readonly result?: JsonValue;
  readonly error?: string;
}

export const meshToolDefinitions: readonly ClientToolDefinition[] = [
  {
    name: "mesh_list_children",
    description: "List cross-harness child sessions delegated by this parent, including their stable IDs, harnesses, and live states.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mesh_message_child",
    description: "Send a follow-up instruction to one delegated child session. If it is still working, the bridge steers when supported or queues the message safely.",
    inputSchema: {
      type: "object",
      properties: {
        child_session_id: { type: "string", description: "Stable child session ID returned by mesh_list_children." },
        message: { type: "string", description: "The follow-up instruction for the child." },
      },
      required: ["child_session_id", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_wait",
    description: "Optionally wait until selected delegated children stop working, need attention, or the timeout expires. Use only when the current response needs their result; children remain tracked if the parent finishes first.",
    inputSchema: {
      type: "object",
      properties: {
        child_session_ids: { type: "array", items: { type: "string" }, description: "Optional child session IDs. Omit to wait for all children." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 300, default: 120 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mesh_read_result",
    description: "Read the latest available assistant result and recent transcript tail from one delegated child session, including after the parent has finished an earlier turn.",
    inputSchema: {
      type: "object",
      properties: {
        child_session_id: { type: "string", description: "Stable child session ID returned by mesh_list_children." },
      },
      required: ["child_session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_eyes",
    description: "Ask this session's configured visual-support model a question about the most recently attached image. Use this when the active model cannot inspect the image itself.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The specific visual fact or observation needed from the image." },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
] as const;

export function defaultMeshRuntimePath(hostId: string, userHome = homedir()): string {
  const safeHostId = hostId.replaceAll(/[^a-zA-Z0-9_-]/gu, "-");
  return join(userHome, ".tethoq", "mesh-runtimes", `${safeHostId}-${process.pid}.json`);
}

export class MeshToolGateway implements ProviderClientTooling {
  public readonly definitions: readonly ClientToolDefinition[];
  readonly #token = randomBytes(32).toString("base64url");
  readonly #hostId: string;
  readonly #pipePath: string;
  readonly #mcpScript: string;
  readonly #execute: MeshToolExecutor;
  readonly #runtimePath: string;
  readonly #sessionBindings = new Map<string, { readonly providerId: string; providerSessionId?: string }>();
  #server: Server | null = null;
  readonly #sockets = new Set<Socket>();

  public constructor(hostId: string, execute: MeshToolExecutor, options: { readonly runtimePath?: string; readonly definitions?: readonly ClientToolDefinition[]; readonly mcpScript?: string } = {}) {
    this.#hostId = hostId;
    this.#pipePath = process.platform === "win32"
      ? `\\\\.\\pipe\\uar-mesh-${hostId.replaceAll(/[^a-zA-Z0-9_-]/gu, "-")}-${process.pid}`
      : `/tmp/uar-mesh-${process.pid}-${randomBytes(8).toString("hex")}.sock`;
    this.#mcpScript = options.mcpScript ?? fileURLToPath(new URL("./mesh_mcp_stdio.js", import.meta.url));
    this.#execute = execute;
    this.definitions = options.definitions ?? meshToolDefinitions;
    this.#runtimePath = options.runtimePath ?? defaultMeshRuntimePath(hostId);
  }

  public async listen(): Promise<void> {
    if (this.#server !== null) return;
    const server = createServer((socket) => this.handleSocket(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#pipePath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await mkdir(dirname(this.#runtimePath), { recursive: true });
    await writeFile(this.#runtimePath, JSON.stringify({
      hostId: this.#hostId,
      pipePath: this.#pipePath,
      token: this.#token,
      tools: this.definitions.map((definition) => definition.name),
      startedAt: new Date().toISOString(),
    }), { encoding: "utf8", mode: 0o600 });
  }

  public async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#sessionBindings.clear();
    if (server === null) return;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    try {
      const runtime = JSON.parse(await readFile(this.#runtimePath, "utf8")) as { readonly token?: string };
      if (runtime.token === this.#token) await unlink(this.#runtimePath);
    } catch {
      // Another bridge may already own the runtime descriptor.
    }
  }

  public async execute(providerId: string, providerSessionId: string, tool: string, input: JsonObject): Promise<JsonValue> {
    return await this.#execute(makeGlobalSessionId(this.#hostId, providerId, providerSessionId), tool, input);
  }

  public async executeForParent(parentSessionId: string, tool: string, input: JsonObject): Promise<JsonValue> {
    return await callMeshToolGateway(this.#pipePath, this.#token, parentSessionId, tool, input);
  }

  public mcpServer(providerId: string, providerSessionId: string): SessionMcpServer {
    const environment = this.runtimeEnvironment();
    return {
      name: "uar_mesh",
      command: process.execPath,
      args: [this.#mcpScript],
      env: {
        ...environment,
        UAR_MESH_PARENT_SESSION_ID: makeGlobalSessionId(this.#hostId, providerId, providerSessionId),
      },
    };
  }

  public createSessionBinding(providerId: string): SessionMcpBinding {
    const bindingId = randomBytes(24).toString("base64url");
    const record: { readonly providerId: string; providerSessionId?: string } = { providerId };
    this.#sessionBindings.set(bindingId, record);
    const environment = this.runtimeEnvironment();
    return {
      server: {
        name: "uar_mesh",
        command: process.execPath,
        args: [this.#mcpScript],
        env: { ...environment, UAR_MESH_BINDING_ID: bindingId },
      },
      bind: (providerSessionId) => {
        if (this.#sessionBindings.get(bindingId) !== record) throw new Error("MCP session binding is no longer active");
        if (providerSessionId.length === 0) throw new Error("MCP session binding requires a provider session ID");
        record.providerSessionId = providerSessionId;
      },
      release: () => {
        if (this.#sessionBindings.get(bindingId) === record) this.#sessionBindings.delete(bindingId);
      },
    };
  }

  public sharedMcpServer(): SessionMcpServer {
    return {
      name: "uar_mesh",
      command: process.execPath,
      args: [this.#mcpScript],
      env: this.runtimeEnvironment(),
    };
  }

  private runtimeEnvironment(): Readonly<Record<string, string>> {
    return {
      UAR_MESH_RUNTIME: this.#runtimePath,
      UAR_MESH_PIPE: this.#pipePath,
      UAR_MESH_TOKEN: this.#token,
      ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
    };
  }

  private handleSocket(socket: Socket): void {
    this.#sockets.add(socket);
    const release = () => this.#sockets.delete(socket);
    socket.once("close", release);
    socket.once("error", release);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      void this.respond(socket, line);
    });
  }

  private async respond(socket: Socket, line: string): Promise<void> {
    let response: GatewayResponse;
    try {
      const request = parseGatewayRequest(line);
      if (request.token !== this.#token) throw new Error("Mesh tool authentication failed");
      const parentSessionId = request.parentSessionId ?? this.boundParentSessionId(request.bindingId);
      const result = await this.#execute(parentSessionId, request.tool, request.input);
      response = { ok: true, result };
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    socket.end(`${JSON.stringify(response)}\n`);
  }

  private boundParentSessionId(bindingId: string | undefined): string {
    if (bindingId === undefined) throw new Error("Mesh tool request is not bound to a session");
    const binding = this.#sessionBindings.get(bindingId);
    if (binding?.providerSessionId === undefined) throw new Error("Mesh tool session binding is not ready");
    return makeGlobalSessionId(this.#hostId, binding.providerId, binding.providerSessionId);
  }
}

export async function callMeshToolGateway(
  pipePath: string,
  token: string,
  parentSessionId: string | undefined,
  tool: string,
  input: JsonObject,
  bindingId?: string,
): Promise<JsonValue> {
  return await new Promise<JsonValue>((resolve, reject) => {
    const socket = createConnection(pipePath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as GatewayResponse;
        if (!parsed.ok) throw new Error(parsed.error ?? "Mesh tool gateway failed");
        resolve(parsed.result ?? null);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({
      token,
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      ...(bindingId !== undefined ? { bindingId } : {}),
      tool,
      input,
    })}\n`));
  });
}

function parseGatewayRequest(line: string): GatewayRequest {
  const parsed = JSON.parse(line) as unknown;
  if (!isJsonObject(parsed) || typeof parsed.token !== "string" || typeof parsed.tool !== "string" || !isJsonObject(parsed.input)) {
    throw new Error("Invalid mesh tool request");
  }
  const parentSessionId = typeof parsed.parentSessionId === "string" && parsed.parentSessionId.length > 0 ? parsed.parentSessionId : undefined;
  const bindingId = typeof parsed.bindingId === "string" && parsed.bindingId.length > 0 ? parsed.bindingId : undefined;
  if (parentSessionId === undefined && bindingId === undefined) throw new Error("Mesh tool request is not session-bound");
  return {
    token: parsed.token,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(bindingId !== undefined ? { bindingId } : {}),
    tool: parsed.tool,
    input: parsed.input,
  };
}
