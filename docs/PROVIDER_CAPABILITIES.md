# Provider capability matrix

Updated: **2026-08-14**

This matrix describes the capabilities advertised by the current adapter code,
not marketing-level provider parity. `Dynamic` means the adapter reads the
running harness's protocol handshake and does not claim a feature that the
installed version did not advertise. `Unavailable` means Tethoq deliberately
shows no value; it does not estimate provider telemetry.

## Built-in adapters

| Provider | Local interface | Session/history support | Approval and input support | Model discovery | Context, tokens, and cost | Compaction |
|---|---|---|---|---|---|---|
| Codex | App Server JSONL over stdio | Full, cursor-paginated | Approvals and requested input | Yes | Context and token usage when App Server reports `thread/tokenUsage/updated`; monetary cost unavailable | Manual; automatic threshold available when the model window is known |
| OpenCode | HTTP/OpenAPI plus SSE | Full; bridge-local pagination over native complete list | Approve once/reject; no general requested-input surface | Yes | Session token totals and USD cost from documented message data; current context from the latest assistant message and model limit | Manual summarize; automatic threshold available when model and limit are known |
| Grok Build | ACP JSON-RPC over stdio | Dynamic | Exact ACP permission choices; no general requested-input surface | Provider metadata when present | Optional ACP context/cost updates plus draft token fields or provider metadata; unavailable when absent | Unavailable |
| Pi | Native RPC JSONL over stdio | Sessions opened by this Tethoq runtime; no private database read | Extension confirmation and input requests | Yes | Native session totals, current context, and USD cost when RPC reports them | Manual; automatic threshold available |
| OMP | Native RPC JSONL over stdio | Sessions opened by this Tethoq runtime; no private database read | Extension confirmation and input requests | Yes | Native session totals, current context, and USD cost when RPC reports them | Manual; automatic threshold available |
| Qwen Code | ACP JSON-RPC over stdio | Dynamic | Exact ACP permission choices | Provider metadata when present | Optional ACP context/cost updates plus draft token fields or provider metadata; unavailable when absent | Unavailable |
| goose | ACP JSON-RPC over stdio | Dynamic | Exact ACP permission choices | Provider metadata when present | Optional ACP context/cost updates plus draft token fields or provider metadata; unavailable when absent | Unavailable |
| Kimi Code | ACP JSON-RPC over stdio | Dynamic | Exact ACP permission choices | Provider metadata when present | Optional ACP context/cost updates plus draft token fields or provider metadata; an open v0.26.0 issue reports that usage does not cross its ACP adapter | Unavailable |
| Hermes Agent | ACP JSON-RPC over stdio | Dynamic | Exact ACP permission choices | Provider metadata when present | ACP context updates when emitted; current upstream can report a harness-estimated used value; cost unavailable unless supplied | Unavailable |
| Cline | ACP JSON-RPC over stdio | Dynamic | Exact ACP permission choices | Provider metadata when present | Optional ACP context/cost updates plus draft token fields or provider metadata; unavailable when absent | Unavailable |
| GitHub Copilot CLI | Public-preview ACP JSON-RPC over stdio | Dynamic | Exact ACP permission choices | Provider metadata when present | Optional ACP context/cost updates plus draft token fields or provider metadata; unavailable when absent | Unavailable |
| Direct API | User-key HTTPS Responses or Chat Completions | Full host-local transcript; bridge-local pagination | Unavailable | Conservative seeds plus compatible `/models` discovery where documented | API-reported token usage; context/pricing metadata when available; session spend is a local calculation, not provider billing; CrofAI credit is shown separately from its documented endpoint | Local transcript summary; automatic threshold available when the model window is known |
| Fake | Deterministic in-process test adapter | Full test coverage | Test-only | Test-only | Test-only | Test-only |

Harness adapters detect the corresponding executable or endpoint and leave
authentication with the installed harness. A missing or unauthenticated
harness remains visible as unavailable; Tethoq does not copy browser cookies,
tokens, or provider-owned credential databases. The Direct API adapter is
always discoverable but cannot send until the selected endpoint has a
user-supplied key; persisted keys are encrypted on the host and never exposed
through the provider contract.

## Common interaction capabilities

| Capability | Codex | OpenCode | Pi / OMP | ACP providers |
|---|---:|---:|---:|---:|
| Detect local availability | Yes | Yes | Yes | Yes |
| Create and continue a session | Yes | Yes | Yes | Yes |
| Stream assistant text and tool activity | Yes | Yes | Yes | Yes |
| Interrupt an active turn | Yes | Yes | Yes | Yes |
| Associate a working directory | Yes | Yes | Yes | Yes |
| Native cursor pagination | Yes | No | No | Dynamic |
| Steering during a turn | Yes | Yes | Yes | Protocol/version dependent |
| Session relationships | Yes | Yes | No | Not currently exposed |
| Edit an existing user message | Yes | No | No | Not currently exposed |

The ACP column covers Grok Build, Qwen Code, goose, Kimi Code, Hermes Agent,
Cline, and GitHub Copilot CLI. Session list/load/resume and provider metadata
are capability-gated per the ACP `initialize` response. GitHub labels Copilot
CLI ACP public preview, so its surface is especially version-sensitive.

## Context bar and compaction semantics

Desktop and mobile show one session-scoped horizontal context bar. The
popover displays harness/API-reported context and tokens. Harness money remains
provider-reported; Direct session spend is shown only when it can be calculated
from known per-token pricing metadata and is identified as local accounting.
Missing fields render as unavailable rather than zero.

The automatic-compaction slider is enabled only when both conditions hold:

1. the adapter exposes manual compaction; and
2. the active model's context-window limit is known.

The threshold cannot exceed the reported model window. Its lower bound is 5%
of that window rounded up to the next 1,000 tokens, with a 1,000-token minimum.
Choosing a threshold at or below current usage requires the full confirmation
dialog and then compacts immediately. Otherwise, Tethoq checks after an
`agent.completed` event and compacts only after the turn, so it does not
interrupt normal streaming. A failed optional telemetry or automatic
compaction call never converts a completed model turn into a failed turn.

Thresholds are Tethoq session state for the current Bridge runtime. Tethoq
does not silently rewrite a provider's global compaction configuration.

## Browser and visual support

Desktop-hosted sessions receive the same Tethoq browser surface through the
harness's documented extension mechanism: dynamic tools for Codex, a local
Tethoq OpenCode tool module, an ACP session MCP server, a Tethoq Pi extension,
OMP host tools, or function tools on a Direct API/model that accepts them.

The browser surface is deliberately narrow:

- list/open/navigate session-isolated tabs;
- inspect bounded visible text and semantic control references;
- click or type only through a reference returned by inspection;
- bounded scrolling; and
- bounded screenshot capture.

It accepts neither arbitrary page scripts nor caller-supplied CSS selectors.
This reduces accidental reach but does not make a signed-in browser harmless;
the agent can still navigate, click, and type with the user's browser session.

If the primary model is known to accept images, attachments use its native
path. Otherwise, when the user has configured a visual-support model,
`ask_eyes` and `browser_capture` send the image to that helper and return a
text observation to the primary session. If no suitable helper is configured,
Tethoq reports that visual support is unavailable instead of pretending the
text-only model saw the image.

## Provider-specific notes

### Codex

The adapter uses the documented App Server stdio transport. Approval response
shapes are preserved per request kind. App Server's provider WebSocket remains
experimental, so remote access still goes through Agent Bridge.

### OpenCode

The native session endpoint returns a complete array, so the adapter's cursor
is local. Cost is the sum of the provider-reported assistant-message cost
fields; it is not reconstructed from a pricing table. Persistent `always`
approval is intentionally omitted from the normalized UI. A live follow-up
uses OpenCode's asynchronous prompt endpoint while the session runner remains
active, matching the native client's in-turn prompt behavior.

### Pi and OMP

Both adapters use the documented `--mode rpc` protocol. Their session list is
limited to RPC processes created by this Tethoq runtime. This boundary avoids
reading undocumented session databases. OMP receives browser/visual/mesh
tools through its documented host-tool callback protocol; Pi loads a
Tethoq-owned extension from Tethoq's data directory.

### ACP providers

Capabilities differ by harness and release. The adapter negotiates rather than
assuming list/load/resume/model support, passes Tethoq tools as an MCP server,
and preserves exact permission option IDs. It accepts optional ACP
`usage_update` context/cost fields, draft end-turn token fields, or provider
extension metadata when present. The current adapter does not expose client
filesystem or terminal delegation to a phone or relay.

### Direct API

The aggregate Direct API entry supports OpenAI Responses and compatible Chat
Completions request shapes. Its endpoint presets cover OpenAI, Vercel AI
Gateway, Z.ai, CrofAI, Google Gemini, OpenRouter, xAI, DeepSeek, Groq,
Mistral, Together, Fireworks, Cerebras, and Perplexity; a user can also add a
custom HTTPS
endpoint. This list identifies request-shape compatibility, not every
vendor-specific feature or every model.

Image attachments and generated inline images are used only when the selected
model/API accepts the relevant content shape. Function tools, including the
bounded browser surface, are exposed only through a compatible tool-calling
path and stop after eight tool rounds. The adapter does not offer approval,
requested-input, streaming-token, steering, or interrupt capabilities.

Direct sessions retain their transcript in the host-local state file so a
stateless API can receive conversation history. Manual compaction replaces
older messages with a deterministic local summary; it is not a claim that the
remote service performed native compaction. CrofAI credit is provider-reported.
Every other optional balance is a local spend cap, not stored value or an
authoritative provider balance.

### Fake provider

The fake provider is deliberately high fidelity for product and protocol
testing. It is never evidence that a real provider supports a feature.
