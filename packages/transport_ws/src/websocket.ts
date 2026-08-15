import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WebSocketServerOptions {
  readonly host?: string;
  readonly port: number;
  readonly path?: string;
  readonly maxMessageBytes?: number;
  readonly clientMustMask?: boolean;
  readonly onHttpRequest?: (request: IncomingMessage, response: ServerResponse) => void;
}

type MessageListener = (text: string) => void | Promise<void>;
type CloseListener = (code: number, reason: string) => void | Promise<void>;
type ErrorListener = (error: Error) => void | Promise<void>;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const first = (fin ? 0x80 : 0) | opcode;
  if (payload.length <= 125) return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.allocUnsafe(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.allocUnsafe(10);
  header[0] = first;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function closePayload(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, "utf8");
  const payload = Buffer.allocUnsafe(2 + Math.min(reasonBytes.length, 123));
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2, 0, payload.length - 2);
  return payload;
}

export class WebSocketConnection {
  readonly #events = new EventEmitter();
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maxMessageBytes: number;
  readonly #clientMustMask: boolean;
  #buffer = Buffer.alloc(0);
  #fragmentOpcode: number | null = null;
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #closed = false;
  #lastPongAt = Date.now();
  #waitingForDrain = false;
  #queuedFrameBytes = 0;
  readonly #queuedFrames: Buffer[] = [];

  public constructor(readonly socket: Socket, options: { readonly maxMessageBytes: number; readonly clientMustMask: boolean }) {
    this.#maxMessageBytes = options.maxMessageBytes;
    this.#clientMustMask = options.clientMustMask;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("drain", () => this.flushQueuedFrames());
    socket.on("close", () => this.finishClose(1006, "Connection closed"));
    socket.on("error", (error) => this.emitError(asError(error)));
  }

  public get isClosed(): boolean {
    return this.#closed;
  }

  public get lastPongAt(): number {
    return this.#lastPongAt;
  }

  public onMessage(listener: MessageListener): () => void {
    this.#events.on("message", listener);
    return () => this.#events.off("message", listener);
  }

  public onClose(listener: CloseListener): () => void {
    this.#events.on("close", listener);
    return () => this.#events.off("close", listener);
  }

  public onError(listener: ErrorListener): () => void {
    this.#events.on("error", listener);
    return () => this.#events.off("error", listener);
  }

  public sendText(text: string): void {
    if (this.#closed) return;
    const payload = Buffer.from(text, "utf8");
    if (payload.length > this.#maxMessageBytes) throw new Error("Outgoing WebSocket message exceeds configured limit");
    this.sendFrame(encodeFrame(0x1, payload));
  }

  public sendJson(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  public ping(payload = Buffer.alloc(0)): void {
    if (this.#closed) return;
    if (payload.length > 125) throw new Error("WebSocket ping payload exceeds 125 bytes");
    this.socket.write(encodeFrame(0x9, payload));
  }

  public close(code = 1000, reason = "Normal closure"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queuedFrames.length = 0;
    this.#queuedFrameBytes = 0;
    this.socket.write(encodeFrame(0x8, closePayload(code, reason)), () => this.socket.end());
    this.#events.emit("close", code, reason);
  }

  private receive(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    try {
      while (this.parseFrame()) {
        // Continue while a complete frame remains buffered.
      }
    } catch (error) {
      this.emitError(asError(error));
      this.close(1002, error instanceof Error ? error.message : "Protocol error");
    }
  }

  private sendFrame(frame: Buffer): void {
    if (!this.#waitingForDrain && this.#queuedFrames.length === 0) {
      this.#waitingForDrain = !this.socket.write(frame);
      return;
    }
    const maxQueuedBytes = this.#maxMessageBytes * 4;
    if (this.#queuedFrameBytes + frame.length > maxQueuedBytes) {
      this.#queuedFrames.length = 0;
      this.#queuedFrameBytes = 0;
      this.close(1013, "Outgoing connection is too slow");
      return;
    }
    this.#queuedFrames.push(frame);
    this.#queuedFrameBytes += frame.length;
  }

  private flushQueuedFrames(): void {
    if (this.#closed) return;
    this.#waitingForDrain = false;
    while (this.#queuedFrames.length > 0 && !this.#waitingForDrain) {
      const frame = this.#queuedFrames.shift();
      if (frame === undefined) break;
      this.#queuedFrameBytes -= frame.length;
      this.#waitingForDrain = !this.socket.write(frame);
    }
  }

  private parseFrame(): boolean {
    if (this.#buffer.length < 2) return false;
    const first = this.#buffer[0] ?? 0;
    const second = this.#buffer[1] ?? 0;
    const fin = (first & 0x80) !== 0;
    const rsv = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if (rsv !== 0) throw new Error("WebSocket extensions are not negotiated");
    if (this.#clientMustMask && !masked) throw new Error("Client WebSocket frames must be masked");
    if (opcode >= 0x8 && (!fin || (second & 0x7f) > 125)) throw new Error("Invalid WebSocket control frame");

    let offset = 2;
    let length = second & 0x7f;
    if (length === 126) {
      if (this.#buffer.length < 4) return false;
      length = this.#buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.#buffer.length < 10) return false;
      const large = this.#buffer.readBigUInt64BE(2);
      if (large > BigInt(Number.MAX_SAFE_INTEGER) || large > BigInt(this.#maxMessageBytes)) throw new Error("WebSocket frame is too large");
      length = Number(large);
      offset = 10;
    }
    if (length > this.#maxMessageBytes) throw new Error("WebSocket frame exceeds configured limit");
    const maskBytes = masked ? 4 : 0;
    if (this.#buffer.length < offset + maskBytes + length) return false;
    const mask = masked ? this.#buffer.subarray(offset, offset + 4) : null;
    offset += maskBytes;
    const payload = Buffer.from(this.#buffer.subarray(offset, offset + length));
    this.#buffer = this.#buffer.subarray(offset + length);
    if (mask !== null) for (let index = 0; index < payload.length; index += 1) payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    this.handleFrame(opcode, fin, payload);
    return true;
  }

  private handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      const reason = payload.length > 2 ? this.#decoder.decode(payload.subarray(2)) : "";
      if (!this.#closed) this.socket.write(encodeFrame(0x8, closePayload(code, reason)));
      this.#closed = true;
      this.socket.end();
      this.#events.emit("close", code, reason);
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(encodeFrame(0xA, payload));
      return;
    }
    if (opcode === 0xA) {
      this.#lastPongAt = Date.now();
      return;
    }
    if (opcode === 0x0) {
      if (this.#fragmentOpcode === null) throw new Error("Unexpected WebSocket continuation frame");
      this.appendFragment(payload);
      if (fin) this.finishMessage(this.#fragmentOpcode);
      return;
    }
    if (opcode !== 0x1 && opcode !== 0x2) throw new Error(`Unsupported WebSocket opcode ${opcode}`);
    if (this.#fragmentOpcode !== null) throw new Error("New data frame arrived before fragmented message completed");
    if (fin) {
      this.dispatchMessage(opcode, payload);
      return;
    }
    this.#fragmentOpcode = opcode;
    this.appendFragment(payload);
  }

  private appendFragment(payload: Buffer): void {
    this.#fragmentBytes += payload.length;
    if (this.#fragmentBytes > this.#maxMessageBytes) throw new Error("Fragmented WebSocket message exceeds configured limit");
    this.#fragments.push(payload);
  }

  private finishMessage(opcode: number): void {
    const payload = Buffer.concat(this.#fragments, this.#fragmentBytes);
    this.#fragmentOpcode = null;
    this.#fragments = [];
    this.#fragmentBytes = 0;
    this.dispatchMessage(opcode, payload);
  }

  private dispatchMessage(opcode: number, payload: Buffer): void {
    if (opcode !== 0x1) throw new Error("Binary WebSocket messages are not supported by this protocol");
    const text = this.#decoder.decode(payload);
    for (const listener of this.#events.listeners("message") as MessageListener[]) {
      Promise.resolve(listener(text)).catch((error: unknown) => this.emitError(asError(error)));
    }
  }

  private emitError(error: Error): void {
    if (this.#events.listenerCount("error") > 0) this.#events.emit("error", error);
  }

  private finishClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queuedFrames.length = 0;
    this.#queuedFrameBytes = 0;
    this.#events.emit("close", code, reason);
  }
}

export class WebSocketServer {
  readonly #server: HttpServer;
  readonly #connections = new Set<WebSocketConnection>();
  readonly #events = new EventEmitter();
  readonly #options: Required<Pick<WebSocketServerOptions, "path" | "maxMessageBytes" | "clientMustMask">> & WebSocketServerOptions;

  public constructor(options: WebSocketServerOptions) {
    this.#options = {
      ...options,
      path: options.path ?? "/",
      maxMessageBytes: options.maxMessageBytes ?? 2 * 1024 * 1024,
      clientMustMask: options.clientMustMask ?? true,
    };
    this.#server = createServer((request, response) => {
      if (this.#options.onHttpRequest !== undefined) this.#options.onHttpRequest(request, response);
      else {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not_found"}\n');
      }
    });
    this.#server.on("upgrade", (request, socket, head) => this.upgrade(request, socket as Socket, head));
  }

  public onConnection(listener: (connection: WebSocketConnection, request: IncomingMessage) => void | Promise<void>): () => void {
    this.#events.on("connection", listener);
    return () => this.#events.off("connection", listener);
  }

  public async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#options.port, this.#options.host);
    });
  }

  public address(): ReturnType<HttpServer["address"]> {
    return this.#server.address();
  }

  public async close(): Promise<void> {
    for (const connection of this.#connections) connection.close(1001, "Server shutdown");
    await new Promise<void>((resolve, reject) => this.#server.close((error) => error === undefined ? resolve() : reject(error)));
  }

  private upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== this.#options.path) throw new Error("WebSocket path not found");
      if (request.headers.upgrade?.toLowerCase() !== "websocket") throw new Error("Missing WebSocket upgrade header");
      const connectionHeader = request.headers.connection?.toLowerCase() ?? "";
      if (!connectionHeader.split(",").map((entry) => entry.trim()).includes("upgrade")) throw new Error("Missing Connection: Upgrade header");
      const version = request.headers["sec-websocket-version"];
      if (version !== "13") throw new Error("Unsupported WebSocket version");
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string" || Buffer.from(key, "base64").length !== 16) throw new Error("Invalid WebSocket key");
      const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"));
      const connection = new WebSocketConnection(socket, {
        maxMessageBytes: this.#options.maxMessageBytes,
        clientMustMask: this.#options.clientMustMask,
      });
      this.#connections.add(connection);
      connection.onClose(() => { this.#connections.delete(connection); });
      for (const listener of this.#events.listeners("connection") as Array<(connection: WebSocketConnection, request: IncomingMessage) => void | Promise<void>>) {
        Promise.resolve(listener(connection, request)).catch((error: unknown) => connection.close(1011, asError(error).message));
      }
      if (head.length > 0) socket.unshift(head);
    } catch (error) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n" + asError(error).message);
      socket.destroy();
    }
  }
}
