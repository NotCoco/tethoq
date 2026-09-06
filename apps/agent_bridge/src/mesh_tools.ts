import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
  type ClientToolExecutionContext,
  type ClientToolDefinition,
  type ClientToolLifecycleOwner,
  type ProviderClientTooling,
  type SessionMcpBinding,
  type SessionMcpServer,
} from "../../../packages/provider_contract/src/index.js";
import { isJsonObject, makeGlobalSessionId, type JsonObject, type JsonValue } from "../../../packages/protocol/src/index.js";

export type MeshToolExecutor = (
  parentSessionId: string,
  tool: string,
  input: JsonObject,
  context?: ClientToolExecutionContext,
) => Promise<JsonValue>;

interface GatewayRequest {
  readonly token: string;
  readonly parentSessionId?: string;
  readonly bindingId?: string;
  readonly tool: string;
  readonly input: JsonObject;
  readonly context?: ClientToolExecutionContext;
}

interface GatewayResponse {
  readonly ok: boolean;
  readonly result?: JsonValue;
  readonly error?: string;
  readonly code?: string;
}

export const meshToolDefinitions: readonly ClientToolDefinition[] = [
  {
    name: "mesh_list_sessions",
    description: "Find other indexed Tethoq tasks on this host. Results are bounded and exclude this task, side chats, and internal helper sessions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200, description: "Optional title, project, folder, or provider search." },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mesh_message_session",
    description: "Send a message to another indexed Tethoq task through its separate inbox. It never steers active work or changes that task's user-authored queue; queued user messages always run first.",
    inputSchema: {
      type: "object",
      properties: {
        target_session_id: { type: "string", description: "Stable task ID returned by mesh_list_sessions." },
        message: { type: "string", maxLength: 32_000, description: "The message for the other task." },
        request_id: { type: "string", maxLength: 256, description: "A stable unique ID for this send. Reuse it only when retrying the same target and message." },
      },
      required: ["target_session_id", "message", "request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_dispatch_delegation",
    description: "Dispatch the targets selected for this turn's prepared Mesh delegation. Supply only contextualized instructions; the bridge enforces the authorized providers, models, reasoning levels, parent session, and one-shot identity.",
    inputSchema: {
      type: "object",
      properties: {
        delegation_id: { type: "string", maxLength: 256, description: "Copy the exact delegation_id from this turn's private Mesh guidance. It identifies an existing prepared delegation; never invent a new ID." },
        assignments: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              target_index: { type: "integer", minimum: 0, maximum: 3 },
              instruction: { type: "string", minLength: 1, maxLength: 32_000 },
            },
            required: ["target_index", "instruction"],
            additionalProperties: false,
          },
        },
      },
      required: ["delegation_id", "assignments"],
      additionalProperties: false,
    },
  },
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
        child_session_ids: { type: "array", items: { type: "string" }, description: "Copy child_session_ids from mesh_dispatch_delegation, or childSessionId from mesh_list_children. Omit to wait for all children." },
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
    name: "tethoq_turn_support",
    description: "Use only when private turn-scoped Tethoq guidance explicitly instructs you to call this tool. Do not infer a purpose or call it without that guidance.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", description: "The request specified by this turn's private Tethoq guidance." },
      },
      required: ["request"],
      additionalProperties: false,
    },
  },
] as const;

export function defaultMeshRuntimePath(hostId: string, userHome = homedir()): string {
  const safeHostId = hostId.replaceAll(/[^a-zA-Z0-9_-]/gu, "-");
  return join(userHome, ".tethoq", "mesh-runtimes", `${safeHostId}-${process.pid}.json`);
}

export function meshRuntimeDirectory(userHome = homedir()): string {
  return join(userHome, ".tethoq", "mesh-runtimes");
}

/**
 * Remove this host's descriptors whose pipe no longer accepts a connection.
 * Every crash, taskkill, or hard exit leaks one descriptor because close()
 * only unlinks on a clean shutdown; without pruning, provider plugins walk an
 * ever-growing list of dead pipes before reaching the live owner. Liveness is
 * probed through the pipe itself, never through PID survival alone: a dead
 * bridge's PID can already belong to an unrelated process.
 */
export async function pruneStaleMeshRuntimes(hostId: string, options: {
  readonly userHome?: string;
  readonly runtimeDirectory?: string;
  readonly currentRuntimePath?: string;
  readonly timeoutMs?: number;
} = {}): Promise<number> {
  const safeHostId = hostId.replaceAll(/[^a-zA-Z0-9_-]/gu, "-");
  const directory = options.runtimeDirectory ?? meshRuntimeDirectory(options.userHome ?? homedir());
  const timeoutMs = options.timeoutMs ?? 500;
  let entries: string[];
  try {
    entries = (await readdir(directory)).filter((file) => file.startsWith(`${safeHostId}-`) && file.endsWith(".json"));
  } catch {
    return 0;
  }
  let pruned = 0;
  await Promise.all(entries.map(async (file) => {
    const path = join(directory, file);
    if (options.currentRuntimePath !== undefined && path === options.currentRuntimePath) return;
    let pipePath: string;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { readonly pipePath?: unknown };
      if (typeof parsed.pipePath !== "string" || parsed.pipePath.length === 0) {
        await unlink(path);
        pruned += 1;
        return;
      }
      pipePath = parsed.pipePath;
    } catch {
      return;
    }
    if (await meshPipeAcceptsConnection(pipePath, timeoutMs)) return;
    try {
      // Re-read before deleting: another bridge may have recycled this exact
      // descriptor path between the probe and now.
      const reread = JSON.parse(await readFile(path, "utf8")) as { readonly pipePath?: unknown };
      if (reread.pipePath !== pipePath) return;
      if (await meshPipeAcceptsConnection(pipePath, timeoutMs)) return;
      await unlink(path);
      pruned += 1;
    } catch {
      // Another bridge owns this path now, or it is already gone.
    }
  }));
  return pruned;
}

function meshPipeAcceptsConnection(pipePath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      resolve(alive);
    };
    let socket;
    try {
      socket = createConnection(pipePath);
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      socket.destroy();
      done(false);
    }, timeoutMs);
    timer.unref?.();
    socket.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      done(true);
    });
  });
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
    // A previous bridge on this host may have leaked descriptors that will
    // otherwise be walked before this live runtime on every provider tool call.
    try {
      await pruneStaleMeshRuntimes(this.#hostId, { runtimeDirectory: dirname(this.#runtimePath), currentRuntimePath: this.#runtimePath });
    } catch {
      // Pruning is best-effort hygiene; it must never block listening.
    }
    const tools = this.definitions.map((definition) => definition.name);
    // Provider processes that loaded the former EYES-specific surface before
    // this runtime started may still call its legacy wire name until they
    // naturally reload. Keep that alias private to runtime discovery.
    if (tools.includes("tethoq_turn_support")) tools.push("ask_eyes");
    await writeFile(this.#runtimePath, JSON.stringify({
      hostId: this.#hostId,
      pipePath: this.#pipePath,
      pid: process.pid,
      token: this.#token,
      tools,
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

  public async execute(
    providerId: string,
    providerSessionId: string,
    tool: string,
    input: JsonObject,
    context?: ClientToolExecutionContext,
  ): Promise<JsonValue> {
    return await this.#execute(makeGlobalSessionId(this.#hostId, providerId, providerSessionId), tool, input, context);
  }

  public async executeForParent(
    parentSessionId: string,
    tool: string,
    input: JsonObject,
    context?: ClientToolExecutionContext,
  ): Promise<JsonValue> {
    return await callMeshToolGateway(this.#pipePath, this.#token, parentSessionId, tool, input, undefined, context);
  }

  public mcpServer(
    providerId: string,
    providerSessionId: string,
    lifecycleOwner: ClientToolLifecycleOwner = "bridge",
  ): SessionMcpServer {
    const environment = this.runtimeEnvironment();
    return {
      name: "uar_mesh",
      command: process.execPath,
      args: [this.#mcpScript],
      env: {
        ...environment,
        UAR_MESH_PARENT_SESSION_ID: makeGlobalSessionId(this.#hostId, providerId, providerSessionId),
        UAR_MESH_CLIENT_TOOL_LIFECYCLE_OWNER: lifecycleOwner,
      },
    };
  }

  public createSessionBinding(
    providerId: string,
    lifecycleOwner: ClientToolLifecycleOwner = "bridge",
  ): SessionMcpBinding {
    const bindingId = randomBytes(24).toString("base64url");
    const record: { readonly providerId: string; providerSessionId?: string } = { providerId };
    this.#sessionBindings.set(bindingId, record);
    const environment = this.runtimeEnvironment();
    return {
      server: {
        name: "uar_mesh",
        command: process.execPath,
        args: [this.#mcpScript],
        env: {
          ...environment,
          UAR_MESH_BINDING_ID: bindingId,
          UAR_MESH_CLIENT_TOOL_LIFECYCLE_OWNER: lifecycleOwner,
        },
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

  public sharedMcpServer(lifecycleOwner: ClientToolLifecycleOwner = "bridge"): SessionMcpServer {
    return {
      name: "uar_mesh",
      command: process.execPath,
      args: [this.#mcpScript],
      env: {
        ...this.runtimeEnvironment(),
        UAR_MESH_CLIENT_TOOL_LIFECYCLE_OWNER: lifecycleOwner,
      },
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
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stopHeartbeat = () => clearInterval(heartbeat);
    try {
      const request = parseGatewayRequest(line);
      if (request.token !== this.#token) throw new Error("Mesh tool authentication failed");
      const parentSessionId = request.parentSessionId ?? this.boundParentSessionId(request.bindingId);
      // Discovery clients have a short inactivity timeout. A connected helper
      // may legitimately take minutes: keep its response alive with JSON
      // whitespace, compatible with plugins already loaded by running agents.
      // Only the final newline completes the one-response wire protocol.
      socket.write(" ");
      heartbeat = setInterval(() => {
        if (!socket.destroyed) socket.write(" ");
      }, 500);
      heartbeat.unref();
      socket.once("close", stopHeartbeat);
      const result = await this.#execute(parentSessionId, request.tool, request.input, request.context);
      response = { ok: true, result };
    } catch (error) {
      const code = gatewayErrorCode(error);
      response = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(code !== undefined ? { code } : {}),
      };
    } finally {
      stopHeartbeat();
      socket.off("close", stopHeartbeat);
    }
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
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
  context?: ClientToolExecutionContext,
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
        if (!parsed.ok) {
          const error = new Error(parsed.error ?? "Mesh tool gateway failed") as Error & { code?: string };
          const code = safeGatewayErrorCode(parsed.code);
          if (code !== undefined) error.code = code;
          throw error;
        }
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
      ...(context !== undefined ? { context } : {}),
    })}\n`));
  });
}

function safeGatewayErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value) ? value : undefined;
}

function gatewayErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  return safeGatewayErrorCode((error as { readonly code?: unknown }).code);
}

function parseGatewayRequest(line: string): GatewayRequest {
  const parsed = JSON.parse(line) as unknown;
  if (!isJsonObject(parsed) || typeof parsed.token !== "string" || typeof parsed.tool !== "string" || !isJsonObject(parsed.input)) {
    throw new Error("Invalid mesh tool request");
  }
  const parentSessionId = typeof parsed.parentSessionId === "string" && parsed.parentSessionId.length > 0 ? parsed.parentSessionId : undefined;
  const bindingId = typeof parsed.bindingId === "string" && parsed.bindingId.length > 0 ? parsed.bindingId : undefined;
  if (parentSessionId === undefined && bindingId === undefined) throw new Error("Mesh tool request is not session-bound");
  const context = clientToolExecutionContext(parsed.context);
  return {
    token: parsed.token,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(bindingId !== undefined ? { bindingId } : {}),
    tool: parsed.tool,
    input: parsed.input,
    ...(context !== undefined ? { context } : {}),
  };
}

function clientToolExecutionContext(value: unknown): ClientToolExecutionContext | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) throw new Error("Invalid mesh tool execution context");
  const callId = typeof value.callId === "string" && value.callId.trim().length > 0
    ? value.callId
    : undefined;
  const lifecycleOwner = value.lifecycleOwner === "bridge" || value.lifecycleOwner === "provider"
    ? value.lifecycleOwner
    : undefined;
  if (value.callId !== undefined && callId === undefined) throw new Error("Invalid mesh tool call identity");
  if (value.lifecycleOwner !== undefined && lifecycleOwner === undefined) throw new Error("Invalid mesh tool lifecycle owner");
  return callId === undefined && lifecycleOwner === undefined
    ? undefined
    : { ...(callId !== undefined ? { callId } : {}), ...(lifecycleOwner !== undefined ? { lifecycleOwner } : {}) };
}
