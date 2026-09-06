# Provider research

Research refreshed: **2026-08-14**

This document records official documentation and material in the projects'
official source repositories. Repository issue reports are identified as
reports rather than treated as stable API contracts. Status labels mean:

- **DOCUMENTED** — explicitly supported by an official protocol, SDK, API, or generated schema.
- **EXPERIMENTAL** — officially published but labelled unstable/experimental or carried in extension metadata.
- **INFERRED** — behavior derived from official source but not promised as a stable public contract.
- **UNSUPPORTED** — no suitable documented integration surface was found or the adapter intentionally does not expose it.
- **DEFERRED** — a relevant surface exists, but a current restriction, known defect, or missing rich lifecycle makes a built-in unsafe to claim.

## Selection result

Tethoq now has twelve researched built-in compatibility entries. Eleven invoke
a separately installed harness through a first-party machine interface. The
twelfth is an aggregate Direct API entry that uses an explicitly supplied user
key with documented HTTPS APIs. Tethoq does not bundle provider executables or
reuse provider artwork.

| Compatibility entry | Built-in | Interface | Upstream license/status |
|---|---:|---|---|
| Codex | Yes | App Server JSONL/stdio | Apache-2.0 |
| OpenCode | Yes | HTTP/OpenAPI + SSE | MIT |
| Grok Build | Yes | ACP/stdio | Apache-2.0 |
| Pi | Yes | Native RPC JSONL/stdio | MIT |
| OMP | Yes | Native RPC JSONL/stdio | MIT |
| Qwen Code | Yes | ACP/stdio | Apache-2.0 |
| goose | Yes | ACP/stdio | Apache-2.0 |
| Kimi Code | Yes | ACP/stdio | MIT |
| Hermes Agent | Yes | ACP/stdio | MIT |
| Cline | Yes | ACP/stdio | Apache-2.0 |
| GitHub Copilot CLI | Yes, public-preview surface | ACP/stdio | GitHub Copilot CLI License; service terms also apply |
| Direct APIs | Yes | OpenAI Responses or compatible Chat Completions over HTTPS | Hosted-service terms, model licenses, account eligibility, and billing remain provider/user-owned |

An open-source license is evidence about the upstream software, not a
trademark license or blanket permission for a hosted service. The product
decision also requires a documented integration surface and no known terms
conflict for the proposed access path. Compatibility names are nominative;
icons are original Tethoq glyphs.

## Direct APIs

### Sources inspected

- OpenAI model/API/data documentation: https://developers.openai.com/api/docs/models, https://developers.openai.com/api/reference/overview, https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint
- Vercel AI Gateway and provider catalog: https://vercel.com/docs/ai-gateway, https://vercel.com/docs/ai-gateway/models-and-providers
- Z.ai HTTP introduction: https://docs.z.ai/guides/develop/http/introduction
- CrofAI API documentation: https://crof.ai/docs
- Google Gemini OpenAI compatibility and current model catalog: https://ai.google.dev/gemini-api/docs/openai, https://ai.google.dev/gemini-api/docs/models
- Google Antigravity terms and supported SDK: https://antigravity.google/terms, https://github.com/google-antigravity/antigravity-sdk-python
- OpenRouter quickstart and Models API: https://openrouter.ai/docs/quickstart, https://openrouter.ai/docs/api/api-reference/models/get-models
- xAI Chat Completions and Models API: https://docs.x.ai/developers/model-capabilities/legacy/chat-completions, https://docs.x.ai/developers/rest-api-reference/inference/models
- DeepSeek Chat Completions and model/pricing guide: https://api-docs.deepseek.com/api/create-chat-completion, https://api-docs.deepseek.com/quick_start/pricing
- Groq OpenAI compatibility and Models API: https://console.groq.com/docs/openai, https://console.groq.com/docs/models
- Mistral Chat API: https://docs.mistral.ai/api
- Together chat inference and Models API: https://docs.together.ai/docs/inference/chat/overview, https://docs.together.ai/reference/models
- Fireworks Chat Completions and model-list client reference: https://docs.fireworks.ai/api-reference/post-chatcompletions, https://docs.fireworks.ai/tools-sdks/python-client/api-reference
- Cerebras authentication and Chat Completions reference: https://inference-docs.cerebras.ai/api-reference/authentication, https://inference-docs.cerebras.ai/api-reference/chat-completions
- Perplexity OpenAI compatibility and Models API: https://docs.perplexity.ai/docs/agent-api/openai-compatibility, https://docs.perplexity.ai/api-reference/models-get

### Selection and implementation

`direct` is one aggregate provider ID. Model IDs retain their endpoint prefix,
so the same underlying model offered by Z.ai, CrofAI, or Vercel remains a
distinct selectable route with its own key, pricing metadata, and terms. The
built-in endpoint presets are OpenAI, Vercel AI Gateway, Z.ai, CrofAI, Google
Gemini, OpenRouter, xAI, DeepSeek, Groq, Mistral, Together, Fireworks,
Cerebras, and Perplexity. A user may add a custom HTTPS endpoint that accepts an OpenAI
Responses or Chat Completions request shape. Loopback HTTP is permitted for
local development; arbitrary remote cleartext HTTP is rejected.

| Concern | Status | Finding and implementation |
|---|---|---|
| Authentication | DOCUMENTED | Presets use provider API keys with Bearer authentication. The user may supply the key through the wallet UI or the provider's conventional host environment variable. Tethoq does not reuse harness subscriptions, browser cookies, or private OAuth state for direct calls. |
| Key storage | TETHOQ SECURITY DESIGN | Keys entered in the app are AES-256-GCM encrypted in the host-local Direct API state file using host-identity-derived key material. Wallet status returns only configured/not-configured and an environment-variable label, never key content. Environment keys are not copied into the state file. |
| Model selection | DOCUMENTED/CAPABILITY-GATED | Conservative seed entries make documented routes understandable before a live catalog is available. The adapter uses a compatible `/models` catalog only where the selected service documents it and the endpoint is reachable; catalog failure does not invent models. Model catalogs change, so availability is never guaranteed. |
| Conversations | DOCUMENTED API + LOCAL STATE | Responses or Chat Completions requests carry the accumulated transcript. Tethoq persists Direct API transcripts locally because these request paths are otherwise stateless; it does not claim a provider-native thread. |
| Images | MODEL/API DEPENDENT | The adapter can send supported image content and preserve returned inline image data. It must not infer vision from a provider name; the selected model and request surface still need to accept the image shape. OpenAI documents image input on its current models and Responses API; other routes remain model-specific. |
| Browser and tools | MODEL/API DEPENDENT | Tethoq exposes its bounded client function tools only on compatible Responses/Chat Completions calls. A model without usable function calling cannot operate the browser through this path. Tool execution is capped at eight rounds. |
| Usage and spend | MIXED | Token counts come from API response usage. A session spend value may be calculated only when current per-token pricing units are known. It is local accounting, not the provider invoice, and remains unavailable otherwise. |
| Provider credit | DOCUMENTED FOR CROFAI ONLY | CrofAI documents `/usage_api/` with usable requests and credits, so that endpoint can populate a provider-credit value. No other preset is presented as having an authoritative provider balance without an equivalent documented response. |
| Local budget | TETHOQ-LOCAL | For endpoints without provider credit, the optional blue-wallet amount is a local spend cap. It is not money deposited with Tethoq, stored value, or a promise that provider billing will stop at the same instant. |
| Compaction | LOCAL | Direct API compaction replaces older local transcript messages with a deterministic text summary. It is not provider-native compaction. The normal model-window bounds and immediate-compaction confirmation still apply. |
| Terms and billing | USER/PROVIDER OWNED | The key holder is responsible for authorization, account eligibility, current service terms, data handling, model licenses, rate limits, prices, and charges. Adding a request-shape-compatible endpoint does not imply endorsement or blanket permission for every model. |
| Artwork | TETHOQ-OWNED | The UI uses original Tethoq glyphs and textual compatibility labels, not provider logos or logo-derived stylizations. |

### Important limitations

- Compatibility means the documented request/response subset implemented by
  this adapter, not every provider extension, endpoint, or model.
- No live Direct API turn was run during the default test suite. Tests
  inject deterministic HTTP responses for key encryption, model/usage shapes,
  image input, function tools, and CrofAI credit.
- Provider catalogs, terms, prices, model availability, and modality/tool
  support can change independently. Re-check the official source before adding
  a new preset or seed.

## OpenAI Codex

### Sources inspected

- Codex App Server documentation: https://developers.openai.com/codex/app-server/
- Codex repository: https://github.com/openai/codex
- Generated App Server TypeScript schemas: https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/typescript
- Local validation on 2026-08-08: `codex-cli 0.147.0` (npm shim on Windows), official source snapshot `main` as observed on 2026-08-07, plus `codex app-server generate-ts` / `generate-json-schema` output generated from the installed binary and a live `codex app-server --listen stdio://`.

### Regenerate protocol evidence

Run against the installed CLI and compare with the curated `packages/provider_codex/src/wire.ts` before every adapter change:

```bash
codex app-server generate-ts -o .codex_protocol_ref/ts
codex app-server generate-json-schema -o .codex_protocol_ref/schema
```

Do not commit the generated tree; record version/commands/results here.

### Live validation (codex-cli 0.147.0, 2026-08-08)

An opt-in local probe confirmed initialization, authentication-state
discovery, cursor-paginated thread listing, history normalization, model
listing, and incremental turn events. Account details, session identifiers,
provider routing, and model catalog results are intentionally not recorded in
this public repository.

### Findings

| Concern | Status | Finding and implementation |
|---|---|---|
| Public integration mechanism | DOCUMENTED | Codex App Server exposes a bidirectional request/notification protocol. Stdio uses one JSON object per line. The bridge starts `codex app-server --listen stdio://` by default. |
| Windows launch | DOCUMENTED | npm-installed Codex is a `.cmd`/`.ps1` shim; Node cannot spawn `.cmd` directly. `packages/provider_contract/src/command.ts` resolves PATH+PATHEXT and launches `.cmd`/`.bat` through `cmd.exe /d /s /c` and `.ps1` through `powershell.exe -File`. Verified live. |
| WebSocket transport | EXPERIMENTAL | App Server documentation describes WebSocket transport as experimental. The adapter deliberately defaults to stdio JSONL. |
| Authentication status | DOCUMENTED | `account/read` returns `{ account: Account\|null, requiresOpenaiAuth: boolean }`. Live-verified. |
| Login | DOCUMENTED | `account/login/start` supports documented ChatGPT, device-code, and API-key variants; responses carry `authUrl`/`verificationUrl`/`userCode`. Implemented as an explicit host-side flow. Browser cookies are not copied. |
| Session/thread listing | DOCUMENTED | `thread/list` supports cursor pagination, sort, cwd filtering, and archived selection. Live-verified without retaining account data. |
| Session history | DOCUMENTED | `thread/read` with `includeTurns` returns turns/items. Live-verified without retaining transcript data. |
| New session | DOCUMENTED | `thread/start`. Implemented with cwd/model and optional first turn. |
| Resume | DOCUMENTED | `thread/resume`. Implemented. |
| Send/continue | DOCUMENTED | `turn/start` with typed `UserInput`. Live-verified; incremental text events observed. |
| Send idempotency | INFERRED | `clientUserMessageId` is a correlation id, not a dedupe key: repeating `turn/start` with the same id started a second turn. The bridge `RequestLedger` is the real send-idempotency boundary (in-memory per bridge process). |
| Thread deletion/writer | INFERRED | A thread owned by one app-server process cannot be deleted from another process while the owner holds the rollout writer ("already has an active writer"). Cleanup must run through the owning connection. |
| Steering | DOCUMENTED | App Server supports turn steering/continued input surfaces. The adapter advertises steering and preserves native events. |
| Streaming events | DOCUMENTED | Server notifications cover thread, turn, item, agent-message deltas, plans, and lifecycle. Implemented through the event normalizer. Live delta/completion notifications observed. |
| Tools/commands/files | DOCUMENTED | Generated item schemas include command execution, tools, file changes, web search, and related updates. Normalizer updated for real `ThreadItem` shapes (`mcpToolCall.tool`, `dynamicToolCall.tool`, `fileChange.changes[].path`, `webSearch.query/results`, `commandExecution` statuses). |
| Approvals | DOCUMENTED | Server requests include `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `applyPatchApproval`, and `execCommandApproval`. Response shapes differ per kind: decision `accept/decline` for the first two; `ReviewDecision` (`approved`/denied) for the legacy two; `{ permissions, scope }` for permissions (no decline case; rejecting grants an empty turn-scoped profile). Exact request IDs/choices preserved. |
| User input | DOCUMENTED | `item/tool/requestUserInput` carries `questions[]`; responses map `{ questionId: { answers: string[] } }`. Implemented with exact bridge binding and answer-shape normalization. |
| Interruption | DOCUMENTED | `turn/interrupt` takes thread and active turn IDs. Implemented. |
| Models | DOCUMENTED | `model/list` is cursor-paginated (`{ data, nextCursor }`). Live-verified without retaining account-specific catalog data. |
| Context/token telemetry | DOCUMENTED | App Server emits `thread/tokenUsage/updated`. Tethoq retains reported input/output/cache totals and the reported model context window. No monetary cost is invented because this event does not provide one. |
| Manual compaction | DOCUMENTED | `thread/compact/start` starts compaction for a thread. Tethoq exposes the control only through the session that owns that thread. |
| Project/directory | DOCUMENTED | Thread start/list/read data includes cwd/project-relevant metadata. Preserved. |
| Provider-native remote access | EXPERIMENTAL | Experimental App Server WebSocket exists, but this product uses the local stdio process and its own authenticated relay. |
| Runtime schema drift | INFERRED | Live responses include Thread fields (`extra`, `historyMode`, `canAcceptDirectInput`) not in `generate-ts` output. The adapter treats unknown fields as opaque native metadata and never drops them. |

### Important limitations

- Account-specific authentication paths were not exercised live. Approval and
  input response mapping is validated against the generated schema through
  deterministic adapter tests.
- Real approval, user-input, and interrupt were not triggered in the opt-in
  smoke; their request/response paths remain deterministically tested.
- Protocol drift must be re-checked against the installed Codex version before production use.

## OpenCode

### Sources inspected

- Server documentation: https://dev.opencode.ai/docs/server/
- Compaction documentation: https://opencode.ai/v2/docs/compaction
- Official repository: https://github.com/anomalyco/opencode
- Generated SDK/OpenAPI types and client: `packages/sdk/js/src/gen/` in the official repository.
- Source snapshot inspected: `284214c78d32a09fd9c729bdefc07be50f74eb40`.

### Findings

| Concern | Status | Finding and implementation |
|---|---|---|
| Public integration mechanism | DOCUMENTED | OpenCode exposes an HTTP/OpenAPI server and Server-Sent Events. The adapter uses HTTP endpoints plus the global event stream. |
| Server authentication | DOCUMENTED | OpenCode server supports optional HTTP Basic authentication. The bridge accepts username/password only as host environment configuration. |
| Provider authentication | DOCUMENTED | OpenCode manages model-provider auth on the host. The bridge reads provider connection status but intentionally does not invent a phone login flow. |
| Session listing | DOCUMENTED | `GET /session` returns sessions. The native endpoint returns a complete array rather than a cursor. |
| Pagination | INFERRED/BRIDGE | The adapter adds deterministic local cursor pagination over the documented complete array so bridge refresh can use one contract. It does not claim native OpenCode pagination. |
| Session history | DOCUMENTED | Session message endpoints return message info and parts. Implemented. |
| New session | DOCUMENTED | `POST /session`. Implemented. |
| Resume/continue | DOCUMENTED | Existing session IDs accept further asynchronous prompts. Adapter resume validates the session; send uses `prompt_async`. |
| Steering | DOCUMENTED | OpenCode accepts another asynchronous prompt while the session runner is active. The adapter exposes that native in-turn follow-up path instead of downgrading the action to a blocked normal send. |
| Streaming events | DOCUMENTED | Global SSE emits session/message/part/status/permission/file events. Implemented with reconnect backoff. |
| Tools/commands/files | DOCUMENTED | Generated event/message-part types identify tool, shell/command, patch, and file changes. Normalized. |
| Approvals | DOCUMENTED | Permission reply accepts `once`, `always`, or `reject`. The MVP intentionally maps only approve-once and reject. |
| User input | UNSUPPORTED IN ADAPTER | No general user-input bridge path was implemented for OpenCode beyond permission prompts. |
| Interruption | DOCUMENTED | Session abort endpoint. Implemented. |
| Models | DOCUMENTED | Provider endpoint returns providers, models, connected providers, and defaults. Implemented. |
| Token and cost telemetry | DOCUMENTED | Assistant message info contains token categories and `cost`. Tethoq sums those provider-reported values for the session and labels cost as USD; it does not recalculate cost from a pricing table. |
| Context window | DOCUMENTED/INFERRED | The current turn's provider-reported tokens are compared with the selected model's documented metadata limit. If either value is missing, the context bar says unavailable. |
| Manual compaction | DOCUMENTED | The current server API exposes `POST /session/:id/summarize` with provider/model selection. OpenCode V2 also documents `POST /api/session/:sessionID/compact`; this adapter currently targets the server API it already speaks. |
| Project/directory | DOCUMENTED | Directory is accepted as request context and appears on sessions. Implemented. |
| Remote connectivity | DOCUMENTED | The HTTP server can be addressed remotely. Secure binding/TLS remains a deployment responsibility; the recommended bridge path keeps it local. |

### Important limitations

- A real OpenCode server was not reachable here.
- The adapter's local pagination requires fetching the native complete session array for each page request; refresh page size is bounded but network efficiency should be profiled on very large indexes.
- Persistent "always allow" is deliberately omitted from the normalized UI until a more explicit risk design exists.

## xAI Grok Build / Agent Client Protocol

### Sources inspected

- Grok Build repository: https://github.com/xai-org/grok-build
- First-party ACP/agent-mode guide: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md
- xAI headless and ACP documentation: https://docs.x.ai/build/cli/headless-scripting
- ACP documentation: https://agentclientprotocol.com/
- ACP repository/schema: https://github.com/agentclientprotocol/agent-client-protocol
- Grok source snapshot inspected: `afbc0fb710320c7add294c2106d447ecc3e3af2e`.
- ACP schema snapshot inspected: `20ae0faf3a9d5eaf8b4e859eac5bb85d927ff659`.

### Findings

| Concern | Status | Finding and implementation |
|---|---|---|
| Public integration mechanism | DOCUMENTED | Grok Build exposes agent mode over ACP. The adapter starts `grok agent stdio` and communicates using JSON-RPC over JSON Lines. |
| Initialization/capabilities | DOCUMENTED | ACP `initialize` negotiates protocol version, client capabilities, agent capabilities, auth methods, and implementation metadata. Implemented. |
| Authentication | DOCUMENTED | ACP agents advertise auth methods and accept `authenticate`. Implemented only for advertised method IDs. |
| Session listing | DOCUMENTED, CAPABILITY-GATED | ACP v1 includes cursor-based `session/list` when `sessionCapabilities.list` is advertised. Grok source advertises it in normal agent mode. Implemented and checked dynamically. |
| Session history | DOCUMENTED, CAPABILITY-GATED | `session/load` replays session updates when load capability is advertised. The adapter captures normalized history during load. |
| New session | DOCUMENTED | `session/new` accepts absolute cwd and MCP servers. The bridge advertises no client filesystem/terminal delegation. Implemented. |
| Resume | DOCUMENTED, CAPABILITY-GATED | `session/resume` accepts session ID, cwd, additional roots, and MCP servers when advertised. Otherwise the adapter uses load where supported. |
| Send/continue | DOCUMENTED | `session/prompt` sends content blocks and streams updates until a stop reason. Implemented. |
| Streaming events | DOCUMENTED | `session/update` includes message/thought chunks, tool calls/updates, plans, modes, and session information. Implemented. |
| Tools/commands/files | DOCUMENTED | ACP tool calls and update content can contain terminal/file locations and diffs. Normalized while retaining native update data. |
| Approvals | DOCUMENTED | Agent-to-client `session/request_permission` carries exact option IDs/kinds; response is selected option or cancelled. Implemented without inventing choices. |
| General user input | UNSUPPORTED IN ADAPTER | ACP permission requests are supported. A separate general elicitation/user-input surface is not exposed by the current Grok adapter. |
| Interruption | DOCUMENTED | `session/cancel` notification. Implemented; pending permission requests are cancelled. |
| Models | EXPERIMENTAL/PROVIDER METADATA | Grok exposes model choices through provider metadata rather than a stable ACP standalone model-list method. Implemented only when entries are present; capability is false otherwise. |
| Project/directory | DOCUMENTED | Absolute cwd and optional additional directories are part of session requests/info. Preserved. |
| Remote connectivity | DOCUMENTED PROTOCOL, LOCAL ADAPTER | ACP is a machine-readable client/agent protocol. This adapter uses local stdio and relies on Agent Bridge for remote transport. |

### Important limitations

- ACP capabilities differ by agent mode/version; the adapter never assumes list/load/resume/model support before `initialize`.
- The bridge currently advertises no ACP client-side filesystem or terminal methods, intentionally preventing delegation of host execution to a phone/relay.
- Real Grok authentication and session behavior were not executed here.

## Pi

### Sources inspected

- Official repository and MIT license: https://github.com/earendil-works/pi
- Native RPC protocol: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
- Extension documentation: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md

### Findings

| Concern | Status | Finding and implementation |
|---|---|---|
| Public integration mechanism | DOCUMENTED | `pi --mode rpc` is explicitly intended for applications, IDEs, and custom UIs. Commands, responses, and events use strict LF-delimited JSONL over stdio. |
| Sessions and messages | DOCUMENTED | RPC exposes new/switch session, state, messages, prompting, steering, follow-up, abort, models, and streaming agent/tool events. |
| Images | DOCUMENTED | Prompt, steer, and follow-up commands accept base64 image content. Tethoq uses the native path only when model capability is known; otherwise it can use the configured visual helper. |
| Context, tokens, and cost | DOCUMENTED | `get_session_stats` reports cumulative token categories, cost, and current context usage/window. Null post-compaction context is preserved as unavailable. |
| Compaction | DOCUMENTED | `compact` and `set_auto_compaction` are public RPC commands. Tethoq uses manual `compact` and keeps its per-session threshold in the Bridge rather than rewriting Pi's global behavior. |
| Tethoq tools | DOCUMENTED EXTENSION SURFACE | Tethoq supplies an original extension from its own data directory for browser, visual-support, and mesh tools. The extension is not Pi code or artwork. |
| Session discovery | INTENTIONALLY LIMITED | Tethoq lists only Pi RPC processes it opened. It does not inspect Pi's private session store. |

Pi's RPC documentation warns that generic line readers which split on Unicode
line separators are not protocol-compliant. The shared process transport
therefore splits only on LF and strips an optional trailing CR.

## OMP (Oh My Pi)

### Sources inspected

- Official repository and MIT license: https://github.com/can1357/oh-my-pi
- Native RPC protocol: https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md

### Findings

| Concern | Status | Finding and implementation |
|---|---|---|
| Public integration mechanism | DOCUMENTED | `omp --mode rpc` exposes newline-delimited commands, responses, events, UI requests, and host callbacks over stdio. |
| Rich lifecycle | DOCUMENTED | The RPC surface covers sessions, paged messages, prompts/queueing, models, login discovery, events, interruption, and compaction. |
| Context, tokens, and cost | DOCUMENTED | OMP retains Pi-compatible `get_session_stats` and `compact` commands. Tethoq reports only values returned by RPC. |
| Browser/vision/mesh tools | DOCUMENTED | `set_host_tools` installs host-owned tool definitions for the active session and returns calls/results on the same RPC stream. This is Tethoq's integration path; no OMP configuration scraping is required. |
| Session discovery | INTENTIONALLY LIMITED | As with Pi, Tethoq lists only RPC processes it owns and does not read an undocumented database. |

## Agent Client Protocol adapters

### Common sources inspected

- ACP specification and versioning: https://agentclientprotocol.com/
- ACP schema repository: https://github.com/agentclientprotocol/agent-client-protocol
- Completed session context/cost RFD: https://agentclientprotocol.com/rfds/session-usage
- Draft end-turn token-usage RFD: https://agentclientprotocol.com/rfds/end-turn-token-usage
- Draft compaction-lifecycle RFD: https://agentclientprotocol.com/rfds/session-compaction

ACP v1 standardizes initialization, authentication advertisement, session
creation/list/load/resume where advertised, prompting, streamed session
updates, cancellation, permission requests, content blocks, and client-provided
MCP servers. Tethoq uses one shared adapter for the providers below while
retaining a distinct provider ID, executable preset, label, and original
Tethoq glyph.

The adapter treats list/load/resume and model metadata as dynamic. ACP v1's
completed Session Context Size and Cost RFD defines optional `usage_update`
notifications. End-turn token accounting in `PromptResponse.usage` remains a
separate Draft as of 2026-08-14, and harness support varies. Tethoq accepts
provider-reported `usage_update`, draft token-usage, and compatible `_meta`
fields during the live process, but never invents them; absent values remain
unavailable. ACP's current compaction RFD is Draft and describes lifecycle
updates, not a client command that starts compaction, so no ACP preset
advertises manual compaction through this adapter.

### Qwen Code

Sources:

- Repository and Apache-2.0 license: https://github.com/QwenLM/qwen-code
- Official settings/CLI reference: https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md
- Official ACP invocation example: https://github.com/QwenLM/qwen-code/blob/main/.qwen/skills/qwen-code-claw/SKILL.md

`qwen --acp` is documented as the stable ACP mode for IDE/editor integration,
replacing the older experimental flag. Tethoq invokes only that public mode
and passes its tool server through the ACP session.

### goose

Sources:

- Repository: https://github.com/aaif-goose/goose
- First-party custom-client/ACP guide: https://github.com/aaif-goose/goose/blob/main/CUSTOM_DISTROS.md
- License metadata: https://github.com/aaif-goose/goose/blob/main/Cargo.toml

The goose guide explicitly documents `goose acp` over stdio for embedded
agents and describes session creation/load/prompt/cancel, streamed tool
updates, permissions, and client-provided MCP servers. The workspace declares
Apache-2.0.

### Kimi Code

Sources:

- Current repository and MIT license: https://github.com/MoonshotAI/kimi-code
- Current license text: https://github.com/MoonshotAI/kimi-code/blob/main/LICENSE
- Current command reference: https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-command.md
- Current ACP usage gap: https://github.com/MoonshotAI/kimi-code/issues/1855

`kimi acp` is the documented JSON-RPC/stdio integration mode. It supports ACP
sessions, streamed updates, tools, permissions, and model configuration as
advertised by the installed version. An open issue report against Kimi Code
0.26.0 documents that usage is tracked internally but is not sent through its
ACP adapter. Tethoq therefore treats token, cost, and context telemetry as
unavailable unless a running version actually emits provider metadata.

### Hermes Agent

Sources:

- Repository and MIT license: https://github.com/NousResearch/hermes-agent
- Programmatic integration guide: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md
- Current ACP adapter source: https://github.com/NousResearch/hermes-agent/blob/main/acp_adapter/server.py

The first-party guide says `hermes acp` runs a JSON-RPC stdio server for IDEs
and custom UIs, including sessions, streaming, tool events, permission
requests, cancellation, and authentication. Current source emits ACP
`usage_update` context values, estimating used context from the harness's own
request inputs when exact counts are unavailable. Tethoq preserves that as a
harness-reported estimate and does not relabel it as tokenizer-exact. No
monetary cost is claimed unless Hermes supplies one.

### Cline

Sources:

- Repository and Apache-2.0 license: https://github.com/cline/cline
- CLI reference: https://github.com/cline/cline/blob/main/apps/cli/README.md
- First-party ACP guide: https://docs.cline.bot/usage/acp

The Cline CLI documents `cline --acp` and provides first-party configuration
examples for ACP clients. Authentication remains Cline/provider-owned.
Tethoq neither reads nor copies Cline's hosted-service credentials and does
not change which model provider the user selected; the launched Cline process
may use the provider the user already configured.

### GitHub Copilot CLI

Sources:

- Official ACP server documentation: https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
- Official CLI repository/changelog: https://github.com/github/copilot-cli
- CLI license: https://github.com/github/copilot-cli/blob/main/LICENSE.md

GitHub documents `copilot --acp --stdio` for a subprocess client and explicitly
lists IDE integrations, CI/CD, custom frontends, and multi-agent systems as use
cases. That first-party page labels ACP support **public preview**, so Tethoq
marks its capabilities dynamic and treats protocol drift as expected. Copilot
authentication, subscription eligibility, model access, billing, and service
terms remain GitHub-owned.

## Deferred or excluded candidates

These are deliberate product boundaries as of 2026-08-14, not claims that a
tool can never be supported and not legal advice.

| Candidate | Status | Reason and primary evidence |
|---|---|---|
| Claude Code | EXCLUDED BY PRODUCT POLICY | The requested release requires explicit permission before a first-party Claude Code entry. No adapter or brand asset is shipped. This is a permission gate, not a claim about technical impossibility. |
| Gemini CLI / Antigravity | DOCUMENTED BYOK ROUTES ONLY | Tethoq must not reuse either product's Google-account OAuth, keyring, login, or consumer subscription: Antigravity's terms explicitly treat third-party software accessing the service through Antigravity OAuth as a breach: https://antigravity.google/terms. Google now documents three machine routes that can be integrated with user-owned API-key or Vertex credentials: Gemini's API/OpenAI-compatible API, official Gemini or Antigravity headless CLI output, and the Antigravity SDK. Google also documents the preview Antigravity Agent Interactions API with agent ID `antigravity-preview-05-2026`: https://ai.google.dev/gemini-api/docs/antigravity-agent and https://antigravity.google/docs/sdk/overview. These contracts permit a future explicit preview adapter; they do not permit automating the consumer website/IDE, importing cached OAuth, scraping private endpoints, or impersonating Google's client. UK/EEA production use must use paid Gemini API/Vertex under the current Additional Terms: https://ai.google.dev/gemini-api/terms. Tethoq currently exposes Gemini through the Direct API wallet using `GOOGLE_API_KEY` or `GEMINI_API_KEY`; an Antigravity preview adapter is researched, not shipped. |
| Cursor | DEFERRED — PERMISSION/SURFACE | Cursor is proprietary and no first-party custom-frontend integration contract was approved for this release. Its official surface documents print/stream-JSON scripting rather than an approved embedded-client protocol: https://docs.cursor.com/en/cli/headless; terms: https://cursor.com/en-US/terms-of-service. Tethoq does not wrap its interactive terminal UI or reuse subscription credentials. |
| Aider | DEFERRED — LIFECYCLE GAP | Official scripting supports one instruction then exit, or direct Python use, but no documented bidirectional session protocol comparable to App Server/RPC/ACP was selected: https://aider.chat/docs/scripting.html. PTY scraping is out of scope. |
| Crush | DEFERRED — PROTOCOL NOT READY | The official ACP request remains an open feature path rather than a released contract: https://github.com/charmbracelet/crush/issues/990. Tethoq will not target a draft branch or scrape its TUI. |
| Kilo Code | DEFERRED — CURRENT ACP DEFECT | Kilo publishes `kilo acp`, but a reproducible report in its official repository documents `session/prompt` stalling without a response or updates for versions 7.2.24 and 7.3.16; the issue was closed as not planned: https://github.com/Kilo-Org/kilocode/issues/10768. Re-evaluate after a fixed release is demonstrated. |

## Cross-provider conclusions

1. Codex App Server, OpenCode HTTP/SSE, Pi/OMP RPC, ACP, and documented Direct
   HTTPS APIs are sufficient machine surfaces; no built-in needs visual
   terminal scraping.
2. Provider parity is intentionally truthful. Codex, OpenCode, Pi, and OMP
   expose useful context/usage data. ACP harnesses may add provider-specific
   usage metadata, but missing values remain unavailable rather than estimated.
   OpenCode, Pi, and OMP have documented harness monetary-cost fields. Direct
   API token spend is explicitly local accounting from known pricing metadata,
   while CrofAI alone currently supplies an authoritative provider-credit
   value through its documented usage endpoint.
3. Browser and visual support are Tethoq client tools delivered through each
   documented extension or API function-tool path. They are not evidence that
   every underlying model accepts image input or function calls.
4. GitHub Copilot CLI's ACP surface is first-party but public preview. All ACP
   capabilities remain negotiated rather than assumed.
5. Compatibility labels are nominative. Tethoq uses original provider glyphs,
   bundles no provider logos, and claims no endorsement or affiliation.
6. Community connector software remains independent executable code subject
   to fingerprint approval; it is not converted into a supported built-in by
   appearing in this research list.
