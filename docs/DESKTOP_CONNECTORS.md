# Desktop harness and connector boundary

Tethoq Desktop lives in `apps/desktop_harness`. Its Electron main process owns
provider processes, credentials, persistence, and the bridge. The sandboxed
React renderer receives only a small, frozen IPC API.

The extension seam is deliberately separate in `packages/connector_sdk`. That
package is MIT licensed and contains no Electron, React, or Desktop
implementation imports. Connector authors can use it without depending on the
rest of the monorepo.

```text
Tethoq Desktop GUI
  -> validated main-process adapter
  -> JSON-RPC 2.0 over newline-delimited JSON
  -> independently installed connector process
  -> model CLI, local daemon, or hosted API
```

## How third-party models appear

1. An author implements the public SDK handlers or the language-neutral wire
   protocol.
2. Their bundle includes `tethoq.connector.json`, which declares identity,
   runtime, permissions, capabilities, and optional static models.
3. A user installs the bundle as one directory under the connector directory
   shown in Desktop Settings.
4. On restart, the main process validates the manifest and presents the exact
   content-and-execution-plan fingerprint and requested permissions for review.
   It does not run an unapproved connector.
5. After explicit approval and restart, Tethoq copies the bundle to an
   app-owned runtime directory, verifies the copy, then starts only that
   snapshot without a shell and performs a versioned handshake. Any content or
   execution-plan change invalidates approval and returns the connector to
   review.
6. Static models appear immediately; a live `provider.models.list` response
   replaces them after initialization. The renderer therefore needs no code
   change for a new provider or model.

The included Echo connector is the compatibility example. It exposes two
models, creates an in-memory task, streams output, returns history, and shuts
down cleanly.

## Trust boundary

Discovery is explicit: Tethoq scans only its connector directory, never npm,
repositories, or arbitrary folders. Each connector runs out of process
with bounded JSON lines, RPC timeouts, output validation, event-rate limiting,
and a filtered environment. The manifest permission declaration is shown to
the user, but it is not an operating-system sandbox; installed connector code
still runs with the current user's rights.

Community connectors are independent third-party software, not reviewed,
endorsed, certified, or supported by Tethoq. Their authors and users are
responsible for ensuring provider access is authorized and complies with the
provider's terms and applicable policies. Credentials should stay with the
provider's local tool or connector and must never be embedded in a manifest or
stored by Tethoq.

The twelve researched built-in compatibility entries are Codex, OpenCode,
Grok Build, Pi, OMP, Qwen Code, goose, Kimi Code, Hermes Agent, Cline, and
GitHub Copilot CLI, plus the aggregate Direct API entry. The first eleven
invoke separately installed harnesses through documented App Server,
HTTP/SSE, RPC, or ACP interfaces; Tethoq does not bundle provider executables.
Direct uses user-supplied keys with documented HTTPS Responses/Chat
Completions endpoints and keeps those encrypted keys in host-local state.
Copilot CLI ACP is public preview and remains capability-gated.

Tethoq does not include, bundle, market, or author a Claude Code integration
in this release. Gemini CLI is deferred because its official terms warn about
third-party access to the services behind the CLI. Cursor, Aider, Crush, and
Kilo Code are also deferred for the permission, lifecycle, or current protocol
reasons recorded in [PROVIDER_RESEARCH.md](PROVIDER_RESEARCH.md). The connector
boundary remains provider-neutral; Tethoq supplies no provider-specific setup
or support for independent connectors.

Approval takes effect after restart. Revocation immediately removes a
connector from the authorized provider set and stops its process; restarting
afterward completes cleanup and lets Desktop rediscover it for review.

## Compatibility rules

The manifest version and wire protocol version evolve independently. Optional
fields and methods may be added compatibly. A breaking manifest change requires
a new `manifestVersion`; a breaking RPC or normalized-data change requires a
new `protocolVersion`. Desktop renderer implementation changes do not require
connector authors to rebuild unless the public protocol itself changes.

See `packages/connector_sdk/README.md` for the authoring guide, manifest rules,
RPC method table, and lifecycle requirements.
