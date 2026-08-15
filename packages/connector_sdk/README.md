# Tethoq Connector SDK

This package is the public seam between Tethoq and a coding harness. A
connector is an independent child process. It never imports Electron, React,
or Desktop implementation modules. The desktop discovers a connector from a
versioned manifest, starts its declared command, and communicates with JSON-RPC
2.0 over newline-delimited JSON (JSONL).

Static `models` in the manifest appear in the model picker immediately.
`provider.models.list` can replace them with a live list after initialization.

Community connectors are independent third-party software. They are not
supported, reviewed, endorsed, or affiliated with Tethoq. Connector authors
and users are responsible for ensuring that every provider integration is
authorized and complies with the provider's terms and applicable policies.
Provider credentials should be handled directly by the provider's local tool
or connector; never embed credential values in a manifest or ask Tethoq to
store them.

## Five-minute connector

```ts
import { parseConnectorManifest, serveConnector } from "@tethoq/connector-sdk";

const manifest = parseConnectorManifest({
  manifestVersion: 1,
  id: "acme.agent",
  name: "Acme Agent",
  version: "1.0.0",
  runtime: { transport: "stdio-jsonl", command: "node", args: ["./connector.js"] },
  permissions: { filesystem: "workspace", network: true, spawnProcesses: false },
  capabilities: {
    listSessions: true,
    sessionHistory: true,
    createSession: true,
    sendMessage: true,
    streamingText: true,
    modelEnumeration: true
  },
  models: [{ id: "acme-1", displayName: "Acme 1", isDefault: true }]
});

serveConnector({
  manifest,
  handlers: {
    detect: () => ({ available: true, details: [] }),
    getAuthStatus: () => ({ authenticated: true, canAuthenticate: false, details: [] }),
    listSessions: async () => ({ sessions: [], nextCursor: null }),
    // Add createSession, listMessages, sendMessage, and subscription handlers.
  }
});
```

See [`examples/echo`](./examples/echo) for a complete model-picker and streaming
example. Non-TypeScript connectors can implement the wire protocol directly.

## Manifest

`tethoq.connector.json` is validated against
[`tethoq.connector.schema.json`](./tethoq.connector.schema.json).

- `id` is stable and lowercase; changing it creates a different connector.
- Desktop accepts either its controlled `node` host with a bundle-relative
  JavaScript entrypoint as the first argument, or a bundle-relative executable.
  Absolute executables, arbitrary `PATH` commands, and entrypoints outside the
  connector bundle are rejected.
- `runtime.env` contains variable **names**, never credential values.
- `permissions` tells users what the connector needs. The host decides whether
  to install or start it; a declaration is not a sandbox.
- `capabilities` drives desktop controls. Undeclared operations are rejected.
- `models` is optional static discovery for a fast, offline model picker.

The host resolves relative commands and working directories against the
manifest directory. Connector discovery and trust/install policy intentionally
remain host responsibilities, outside this SDK.

## Wire protocol

Each stdin/stdout line is one UTF-8 JSON-RPC 2.0 object, up to 8 MiB. Stdout is
reserved for protocol messages; diagnostics belong on stderr. The connector
must receive `connector.initialize` before operational methods.

Host to connector requests:

| Area | Methods |
| --- | --- |
| Lifecycle | `connector.initialize`, `connector.ping`, `connector.shutdown` |
| Provider | `provider.detect`, `provider.auth.status`, `provider.auth.start`, `provider.capabilities`, `provider.models.list` |
| Sessions | `session.list`, `session.get`, `session.messages.list`, `session.create`, `session.resume` |
| Messages | `session.message.send`, `session.message.steer`, `session.message.edit`, `session.interrupt` |
| Queue | `session.queue.list`, `session.queue.enqueue`, `session.queue.cancel` |
| Interaction | `approval.respond`, `userInput.respond` |
| Events | `events.subscribe`, `events.unsubscribe` |

Connector to host:

- Notification `events.emit` carries `{ subscriptionId, event }`.
- Notification `host.log` carries structured diagnostics.
- Optional request `host.tool.execute` asks the host to run an explicitly
  exposed client tool. The host may reject it.

`session.queue.list` is provider-wide when called with `{}`. Pass
`{ sessionId }` to filter the result to one session; connectors should support
both forms for compatibility.

Errors use standard JSON-RPC codes plus:

- `-32001`: not initialized
- `-32002`: already initialized
- `-32003`: capability not declared
- `-32004`: protocol version mismatch

## Lifecycle and security

1. The host validates the manifest before launch and shows requested
   permissions to the user. Tethoq Desktop does not start a newly discovered
   connector until the user explicitly approves its exact content and execution
   plan fingerprint. Approval takes effect after restart.
2. Desktop copies the approved bundle to an app-owned runtime directory,
   verifies that copy, and launches only that immutable-for-launch snapshot.
3. The host launches without a shell and passes only explicitly allowlisted
   environment variables. The process client deliberately does not inherit the
   parent environment.
4. The host calls `connector.initialize`; connector id and protocol version
   must match the manifest.
5. Calls are bounded by timeouts and an abort signal. Pending-call count and
   line size are bounded.
6. The host sends `connector.shutdown`, waits briefly, then terminates an
   unresponsive process. Connector shutdown must release subscriptions and
   children it owns.
7. Approval takes effect after Desktop restarts. Revocation immediately removes
   the connector from the authorized provider set and stops its process; a
   later restart completes cleanup and rediscovery.

Third-party connector code is executable code. A future registry should add
signature, publisher, review, and update policy; it must not treat schema-valid
manifests as trusted.

## Compatibility

Manifest and wire protocol versions evolve independently of the Desktop
implementation. Adding optional fields or methods is backward compatible.
Breaking wire or normalization changes require a new `protocolVersion`;
breaking manifest changes require a new `manifestVersion`.
