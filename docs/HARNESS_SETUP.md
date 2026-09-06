# Connect a harness

On Windows, install Node.js 22.13 or newer, clone this repository, and run
these commands from its root:

```powershell
npm run setup:desktop
npm start
```

Setup installs the root and Desktop dependencies from their lockfiles and
downloads the pinned Electron runtime through Desktop's postinstall step. The
development launcher builds the Electron main/preload/renderer code directly
from source; no copied `dist` tree, pre-existing Tethoq identity, or developer's
machine configuration is needed. The first install needs network access for
npm packages and Electron. The Bridge, relay, website and Flutter app do not
need to be started separately to use the local desktop.

Install at least one supported harness separately and complete its normal
login/provider configuration. Tethoq starts detecting harnesses when it opens.
It can launch their protocol processes and wire up its tools, but cannot supply
an account, subscription, model provider or executable you have not installed.

In **Settings > Harness connections**, choose a harness to see its status,
installation guide, retry button and **Copy setup prompt**. Give that prompt to
a coding agent that can read this checkout. **Other harness** provides the
connector authoring contract, installation folder and verification checklist.
Prompts do not include credentials, environment contents, chat history or
runtime error dumps. Connection errors appear locally in the panel.

## Automatic connections

| Harness | Default process/interface | Tethoq tools |
| --- | --- | --- |
| Codex | `codex app-server` (App Server) | App Server client tools |
| OpenCode | Discovered HTTP/SSE server, or `opencode serve --hostname 127.0.0.1 --port 4096` | Installed custom tool and local gateway |
| Grok Build | `grok agent stdio` (ACP) | Session-bound MCP, capability-negotiated |
| Pi | `pi --mode rpc` | Tethoq extension supplied to normal sessions |
| OMP | `omp --mode rpc` | Native `set_host_tools` / `host_tool_call` / `host_tool_result` RPC |
| Qwen Code | `qwen --acp` | Session-bound MCP, capability-negotiated |
| goose | `goose acp` | Session-bound MCP, capability-negotiated |
| Kimi Code | `kimi acp` | Session-bound MCP, capability-negotiated |
| Hermes Agent | `hermes acp` | Session-bound MCP, capability-negotiated |
| Cline | `cline --acp` | Session-bound MCP, capability-negotiated |
| GitHub Copilot CLI | `copilot --acp --stdio` (preview) | Session-bound MCP, capability-negotiated |
| Direct API | User-configured HTTPS endpoint/key | Adapter-owned tool loop |

The installed harness controls its auth and native capabilities. **Connected**
means its connection/auth checks succeeded; it does not certify every tool or
model. Unsupported features remain unavailable. See
[Provider capabilities](PROVIDER_CAPABILITIES.md).

Tethoq installs the OpenCode helper at
`~/.config/opencode/tools/uar_mesh.ts` and the Pi extension at
`~/.tethoq/provider-tools/pi-tethoq-tools.mjs`. An installation failure is
reported in Harness connections without blocking other providers. **Retry
connection** retries the helper installation too. Existing OpenCode servers
remain running; if one has already loaded its tool configuration, create a new
session or restart that server yourself after finishing active work.

If the CLI is missing from PATH, first check `<command> --version` in a fresh
terminal. Fully quit Tethoq through its tray menu and reopen it after an
installation or environment change. Closing the window can leave the old
process and environment alive. Custom executable locations can be supplied
with `TETHOQ_<ID>_COMMAND` and protocol arguments with `TETHOQ_<ID>_ARGS` as a
JSON string array. IDs are uppercase (`GROK`, `CODEX`, `PI`, `OMP`, `QWEN`,
`GOOSE`, `KIMI`, `HERMES`, `CLINE`, `COPILOT`). Set environment overrides in the
terminal that launches Tethoq or in your user environment. For example:

```powershell
$env:TETHOQ_GROK_COMMAND = 'C:\path with spaces\grok.exe'
$env:TETHOQ_GROK_ARGS = '["agent","stdio"]'
npm start
```

OpenCode accepts `TETHOQ_OPENCODE_COMMAND` and `TETHOQ_OPENCODE_URL`; Tethoq
manages its server arguments. A protected server also needs its matching
`TETHOQ_OPENCODE_USERNAME`/`TETHOQ_OPENCODE_PASSWORD` or
`OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD` in the launcher
environment. Keep these values out of source and shared prompts.

## Connector tools

The [Connector SDK](../packages/connector_sdk/README.md) is the extension seam.
Desktop supplies optional `clientTools` definitions in `session.message.send`
and `session.message.steer`. Register the supplied name, description and
`inputSchema` with the harness, replacing the previous turn's list. Return
each call through `context.executeHostTool({ sessionId, name, input })` and
deliver the actual structured result back to the harness. Use the native
session ID from the request. Tool access begins with a Desktop-dispatched
turn, so do not call host tools during initialize or session creation.

Desktop binds these calls to the approved connector's provider and the
session's exposed tool list; it never gives connectors gateway tokens.
An empty list disables tools. `session.create` may request `clientTools: "none"`
and `mcpServers: "none"` for helpers. Connector authors must honor both and
must not claim tool isolation unless their harness enforces it. Unknown
session IDs, disabled tools and calls after disposal are rejected.

Installing a connector requires the user's review of its exact fingerprint
and permissions under **External connectors**, followed by restart. Approval
does not establish full compatibility: test model discovery, create/resume,
history, streaming completion, interrupt, supported approval/input/queue
flows, and a harmless tool round trip. See [Desktop connectors](DESKTOP_CONNECTORS.md)
for the trust and lifecycle rules. The **Other harness** prompt includes these
requirements and the current source locations to help another agent finish
and verify an implementation.
