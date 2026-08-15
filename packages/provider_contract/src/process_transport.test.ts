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
