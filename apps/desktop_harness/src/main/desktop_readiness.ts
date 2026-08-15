import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const LOOPBACK = "127.0.0.1";

export interface DesktopReadinessHandle {
  readonly path: string;
  readonly port: number;
  dispose(): Promise<void>;
}

/** Publishes an opaque, user-scoped readiness endpoint for the independent Bridge. */
export async function startDesktopReadiness(path: string): Promise<DesktopReadinessHandle> {
  const token = randomBytes(32).toString("base64url");
  const route = `/tethoq-desktop-ready/${token}`;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === route) {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"not_found"}\n');
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await close(server);
    throw new Error("Desktop readiness listener has no TCP address");
  }
  await writeDescriptor(path, { version: 1, port: address.port, token });
  let disposed = false;
  return {
    path,
    port: address.port,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await close(server);
      await rm(path, { force: true });
    },
  };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LOOPBACK);
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function writeDescriptor(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
