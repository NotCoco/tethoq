import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  waitForQuickTunnelReadiness,
  type TunnelFetch,
  type TunnelProbeSocket,
  type TunnelProbeSocketFactory,
} from "./phone_pair_tunnel.js";

class FakeTunnelChild extends EventEmitter {
  public exitCode: number | null = null;
  public killed = false;
}

class FakeProbeSocket implements TunnelProbeSocket {
  readonly #open = new Set<() => void>();
  readonly #messages = new Set<(text: string) => void>();
  readonly #errors = new Set<(error: Error) => void>();
  readonly #close = new Set<() => void>();
  public closed = false;

  public onOpen(listener: () => void): () => void { return add(this.#open, listener); }
  public onMessage(listener: (text: string) => void): () => void { return add(this.#messages, listener); }
  public onError(listener: (error: Error) => void): () => void { return add(this.#errors, listener); }
  public onClose(listener: () => void): () => void { return add(this.#close, listener); }
  public close(): void { this.closed = true; }
  public emitHello(): void {
    for (const listener of this.#open) listener();
    for (const listener of this.#messages) listener('{"type":"protocol.hello"}');
  }
  public emitError(error: Error): void {
    for (const listener of this.#errors) listener(error);
  }
}

function add<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function child(): Parameters<typeof waitForQuickTunnelReadiness>[1] {
  return new FakeTunnelChild() as unknown as Parameters<typeof waitForQuickTunnelReadiness>[1];
}

function dnsResponse(resolves: boolean) {
  return {
    ok: true,
    status: 200,
    json: async () => resolves
      ? { Status: 0, Answer: [{ type: 1, data: "104.16.230.132" }] }
      : { Status: 3 },
  };
}

test("quick tunnel readiness accepts either public DNS resolver and requires protocol.hello", async () => {
  const dnsUrls: string[] = [];
  let dnsRound = 0;
  const fetchDns: TunnelFetch = async (url) => {
    dnsUrls.push(url);
    dnsRound += 1;
    return dnsResponse(url.startsWith("https://cloudflare-dns.com/") && dnsRound > 2);
  };
  const sockets: FakeProbeSocket[] = [];
  const socketFactory: TunnelProbeSocketFactory = (url, address) => {
    assert.equal(url, "wss://ready-example.trycloudflare.com/bridge");
    assert.equal(address, "104.16.230.132");
    const socket = new FakeProbeSocket();
    sockets.push(socket);
    setImmediate(() => socket.emitHello());
    return socket;
  };

  await waitForQuickTunnelReadiness("https://ready-example.trycloudflare.com", child(), {
    fetch: fetchDns,
    socketFactory,
    timeoutMs: 500,
    retryDelayMs: 1,
    socketAttemptTimeoutMs: 100,
  });

  assert.ok(dnsUrls.some((url) => url.startsWith("https://cloudflare-dns.com/")));
  assert.ok(dnsUrls.some((url) => url.startsWith("https://dns.google/")));
  assert.equal(sockets.length, 1, "WSS is probed after a public resolver reports the hostname twice");
  assert.equal(sockets[0]?.closed, true, "the successful readiness probe is closed");
});

test("quick tunnel readiness retries failed WSS probes and closes every probe", async () => {
  const fetchDns: TunnelFetch = async () => dnsResponse(true);
  const sockets: FakeProbeSocket[] = [];
  const socketFactory: TunnelProbeSocketFactory = () => {
    const socket = new FakeProbeSocket();
    sockets.push(socket);
    setImmediate(() => {
      if (sockets.length === 1) {
        socket.emitError(new Error("not ready"));
      } else {
        socket.emitHello();
      }
    });
    return socket;
  };

  await waitForQuickTunnelReadiness("https://retry-example.trycloudflare.com", child(), {
    fetch: fetchDns,
    socketFactory,
    timeoutMs: 500,
    retryDelayMs: 1,
    socketAttemptTimeoutMs: 20,
  });

  assert.equal(sockets.length, 2);
  assert.ok(sockets.every((socket) => socket.closed));
});

test("quick tunnel readiness rejects promptly when cloudflared exits", async () => {
  const tunnelChild = new FakeTunnelChild();
  const fetchDns: TunnelFetch = async (_url, init) => await new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  const operation = waitForQuickTunnelReadiness(
    "https://exit-example.trycloudflare.com",
    tunnelChild as unknown as Parameters<typeof waitForQuickTunnelReadiness>[1],
    { fetch: fetchDns, socketFactory: () => new FakeProbeSocket(), timeoutMs: 500 },
  );
  setImmediate(() => {
    tunnelChild.exitCode = 1;
    tunnelChild.emit("exit", 1);
  });
  await assert.rejects(operation, /cloudflared exited while verifying.*code 1/u);
});

test("quick tunnel readiness follows desktop cancellation", async () => {
  const controller = new AbortController();
  const fetchDns: TunnelFetch = async (_url, init) => await new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  const operation = waitForQuickTunnelReadiness("https://cancel-example.trycloudflare.com", child(), {
    fetch: fetchDns,
    socketFactory: () => new FakeProbeSocket(),
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  controller.abort(new Error("desktop shutdown cancelled pairing"));
  await assert.rejects(operation, /desktop shutdown cancelled pairing/u);
});

test("quick tunnel readiness timeout reports the last failed public check", async () => {
  const fetchDns: TunnelFetch = async () => dnsResponse(false);
  await assert.rejects(
    waitForQuickTunnelReadiness("https://missing-example.trycloudflare.com", child(), {
      fetch: fetchDns,
      socketFactory: () => new FakeProbeSocket(),
      timeoutMs: 30,
      retryDelayMs: 1,
      socketAttemptTimeoutMs: 10,
    }),
    /Timed out after 1s.*Last check: .*DNS does not resolve/u,
  );
});
