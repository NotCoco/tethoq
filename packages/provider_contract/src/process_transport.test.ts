import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonRpcPeer } from "./json_rpc.js";
import { JsonLineProcessTransport } from "./process_transport.js";

test("missing process executable rejects a request and closes safely", async () => {
  const transport = new JsonLineProcessTransport({
    command: join(tmpdir(), `tethoq-missing-${randomUUID()}.exe`),
    args: [],
  });
  const peer = new JsonRpcPeer(transport, { timeoutMs: 100 });

  await assert.rejects(
    peer.request("ping"),
    (error: unknown) => error instanceof Error
      && ((error as NodeJS.ErrnoException).code === "ENOENT" || /ENOENT/u.test(error.message)),
  );
  await peer.close();
});

test("large JSONL responses are parsed after bounded chunk accumulation", async (t) => {
  const payloadChars = 512 * 1024;
  const childScript = 'process.stdin.once("data", () => { const value = "x".repeat(524288); process.stdout.write(JSON.stringify({ id: "reply", result: { value } }) + "\\n"); });';
  const transport = new JsonLineProcessTransport({
    command: process.execPath,
    args: ["-e", childScript],
  });
  t.after(async () => await transport.close());
  const message = await new Promise<unknown>(async (resolve, reject) => {
    const unsubscribe = transport.onMessage((value) => {
      unsubscribe();
      resolve(value);
    });
    try {
      await transport.send({ id: "reply", method: "large" });
    } catch (error) {
      unsubscribe();
      reject(error);
    }
  });
  assert.equal((message as { readonly result: { readonly value: string } }).result.value.length, payloadChars);
});

test("an unexpected child exit is reported to the JSON-RPC peer without waiting for timeout", async () => {
  const childScript = 'process.stdin.once("data", () => process.exit(7));';
  const transport = new JsonLineProcessTransport({ command: process.execPath, args: ["-e", childScript] });
  const peer = new JsonRpcPeer(transport, { timeoutMs: 60_000 });
  const startedAt = Date.now();

  await assert.rejects(peer.request("exit-now"), /exited.*code 7/iu);
  assert.ok(Date.now() - startedAt < 5_000, "process exit must reject promptly instead of waiting for the RPC timeout");
});
