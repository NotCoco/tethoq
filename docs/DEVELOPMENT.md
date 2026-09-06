# Development

## Node workspace

Requirements:

```text
Node >= 22
npm >= 10
TypeScript 5.8.3 (locked)
```

Install and verify:

```bash
npm ci
npm run verify
```

The root TypeScript configuration compiles all bridge, relay, transport, protocol, and provider packages into `dist/` while preserving repository-relative paths. Source packages use direct typed imports across the monorepo; runtime entrypoints are the compiled bridge and relay files.

## Scripts

| Command | Purpose |
|---|---|
| `npm run clean` | Remove generated `dist/`. |
| `npm run build` | Compile TypeScript and declarations/source maps. |
| `npm run typecheck` | Strict no-emit TypeScript validation. |
| `npm test` | Build, discover every compiled `*.test.js`, and run Node's test runner. |
| `npm run quality` | Scan source for accidental scaffolding and hardcoded secret patterns. |
| `npm run verify` | Typecheck, test, and quality gate. |
| `npm run start:bridge -- [flags]` | Start compiled Agent Bridge. |
| `npm run start:relay` | Start compiled relay. |

## Bridge flags

```text
--config PATH
--host ADDRESS
--port PORT
--path PATH
--pair
--no-relay
--fake
--allow-unsigned-local
--help
```

Environment variables are documented in `.env.example`. Every
`TETHOQ_<PROVIDER>_ARGS` override must be a JSON string array. Supported
process prefixes are `CODEX`, `GROK`, `PI`, `OMP`, `QWEN`, `GOOSE`, `KIMI`,
`HERMES`, `CLINE`, and `COPILOT`; OpenCode normally uses
`TETHOQ_OPENCODE_URL`. Legacy `UAR_*` names remain accepted as fallbacks.

## Local bridge configuration

The default file is:

```text
~/.tethoq/bridge.json
```

It is generated automatically and contains:

- configuration version;
- stable host ID/display name;
- Ed25519 host public/private key;
- enabled provider IDs;
- optional relay URL/token.

Paired device public credentials and revocations are stored in `paired-devices.json` beside it. Do not commit either file.

Upgrades reuse `~/.universal-agent-remote/bridge.json` when that legacy file exists and the new path does not, preserving the existing host identity and paired-device state.

To change enabled providers, edit `enabledProviders` while the bridge is
stopped. Current built-in IDs are `codex`, `opencode`, `grok`, `pi`, `omp`,
`qwen`, `goose`, `kimi`, `hermes`, `cline`, `copilot`, and `direct`; `fake` is
reserved for deterministic development.

Default local entrypoints:

| Provider | Command or endpoint |
|---|---|
| Codex | `codex app-server --listen stdio://` |
| OpenCode | `http://127.0.0.1:4096/` |
| Grok Build | `grok agent stdio` |
| Pi | `pi --mode rpc` |
| OMP | `omp --mode rpc` |
| Qwen Code | `qwen --acp` |
| goose | `goose acp` |
| Kimi Code | `kimi acp` |
| Hermes Agent | `hermes acp` |
| Cline | `cline --acp` |
| GitHub Copilot CLI | `copilot --acp --stdio` |
| Direct API | User-selected documented HTTPS endpoint |

Detection is independent. A missing executable makes only that provider
unavailable. Never add a PTY-scraping fallback when a harness has no suitable
documented protocol.

## Running direct development mode

```bash
npm run build
npm run start:bridge -- --fake --pair --no-relay
```

The default direct endpoint is `ws://127.0.0.1:8765/bridge`. Use port `0` only from tests/code that can inspect the assigned address; the CLI's printed address handles it correctly.

## Running the relay

```bash
export TETHOQ_RELAY_HOST=127.0.0.1
export TETHOQ_RELAY_PORT=8787
npm run start:relay
```

The relay's default path is `/relay`, and `/healthz` returns room count. The bridge relay client reconnects with backoff after disconnection.

For production-like local testing, place a TLS reverse proxy in front and connect with `wss://`. The relay process itself does not terminate TLS.

## Provider adapter development

A provider adapter should:

1. Implement `AgentProviderAdapter` from `packages/provider_contract/src/types.ts`.
2. Preserve native IDs and relevant native metadata.
3. Return truthful capabilities.
4. Normalize sessions/messages/events without discarding security context.
5. Throw `UnsupportedProviderCapabilityError` for unsupported optional calls.
6. Keep provider credentials on the host.
7. Add official-protocol fixtures and normalization tests.
8. Survive provider disposal and pending approval/input cancellation.
9. Be registered in `apps/agent_bridge/src/providers.ts` only after it has a clear purpose.
10. Update provider research/capability/build-status documents.
11. Implement `getSessionContext` from provider/API usage values. Harness
    adapters use only harness-reported context/cost. A direct API adapter may
    calculate a clearly non-authoritative spend value from current documented
    or catalog pricing; omit it when pricing is absent.
12. Implement `compactSession` only for a documented native operation or the
    Direct API adapter's explicit local transcript-summary operation. The
    bridge enables automatic thresholds only when compaction and a model
    context-window limit are both available. Resolve only when the compacted
    context is ready for another turn; request acceptance is insufficient.
    Reject on failure, cancellation, or unconfirmed completion, and keep
    provider event processing available while waiting for the native lifecycle.

Do not implement an adapter from an inferred endpoint name. Research and record the official source first.

The shared ACP adapter is used for Grok Build, Qwen Code, goose, Kimi Code,
Hermes Agent, Cline, and GitHub Copilot CLI. Add a preset only when the
maintainer documents the executable's ACP mode. Capabilities must continue to
come from `initialize`; provider-specific `_meta` is optional, not a promise.
Preserve completed ACP `usage_update` fields (`used`, `size`, and optional
currency-tagged `cost`) exactly. End-turn token usage is still a Draft ACP
shape, so accept it defensively and render it unavailable when absent.

Pi and OMP share the strict JSONL RPC client but remain separate provider IDs.
Split records only on LF. Pi's protocol explicitly permits Unicode line
separators inside JSON strings, so Node `readline` is not suitable.

## Browser and visual-support tools

The Desktop runtime owns the Chromium workspace. Its agent surface accepts
only bounded navigation, inspection, semantic-reference click/type, scrolling,
and capture operations. Do not add arbitrary selector or script execution to
this boundary. Browser tabs and semantic references are scoped to the parent
session.

Tool delivery is provider-specific but definitions remain common:

- Codex dynamic tools;
- Tethoq's local OpenCode tool module;
- the per-session MCP server for ACP harnesses;
- Tethoq's Pi extension; and
- OMP's `set_host_tools` callback protocol; and
- OpenAI Responses or compatible Chat Completions function tools for Direct
  API models that accept them.

`browser_capture` and attachment fallback call the configured visual-support
model through the bridge. Tests must use fake transports/captures. Never make
a paid provider turn part of the default test suite.

## Protocol changes

Protocol v1 source files:

```text
packages/protocol/src/envelopes.ts
packages/protocol/src/validation.ts
packages/protocol/src/models.ts
packages/protocol/schema/protocol-v1.schema.json
```

For a compatible additive change, update TypeScript, runtime validation, JSON Schema, Flutter decoding, and tests together. For an incompatible change, create protocol v2 and negotiate it explicitly; do not redefine v1 in place.

Canonical signed-action JSON must remain byte-compatible between Node and Dart. Add cross-language vectors before changing canonicalization.

## Flutter development

From `apps/remote_client`:

```bash
flutter create . \
  --platforms=android,ios,macos,windows,linux \
  --project-name universal_agent_remote
flutter pub get
flutter analyze
flutter test
```

Then run at least:

```bash
flutter run -d macos      # on macOS
flutter run -d windows    # on Windows
flutter run -d linux      # on Linux
flutter run -d android
flutter run -d ios
```

Validate:

- secure-storage write/read after restart;
- Ed25519 interoperability with Node;
- direct and relay pairing;
- foreground/background reconnect;
- request retry without duplicate turns;
- event replay/deduplication;
- approval expiry and stale response handling;
- keyboard/composer preservation;
- host revocation/removal;
- Android API level and iOS Keychain entitlements.

Desktop uses `models.list` for a capability-aware new-session picker. Mobile
starts a new session with the harness default and exposes the advertised model
picker from the session. If enumeration is absent or fails, both clients keep
the harness default instead of inventing a catalog.

The current transport uses `dart:io` and therefore does not support Flutter web. Add a conditional browser transport before enabling the web platform.

## Style and quality

TypeScript uses strict mode, exact optional property types, unused-symbol errors, and no implicit fallthrough. Runtime JSON must not be trusted simply because an interface exists.

Before committing:

```bash
npm run verify
python -m json.tool packages/protocol/schema/protocol-v1.schema.json >/dev/null
git diff --check
rg -n 'TODO|FIXME|placeholder|mocked|unimplemented|throw new Error\("Not implemented"\)|api[_-]?key\s*[:=]\s*["'"'][^"'"']+' . \
  -g '!dist/**' -g '!node_modules/**' -g '!.git/**'
```

Review every match rather than deleting legitimate terminology blindly.
