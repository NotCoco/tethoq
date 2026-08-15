# Security

## Security goals

1. Provider credentials remain on the development host whenever possible.
2. A relay cannot approve or issue coding-agent actions without a paired device key.
3. Approvals are bound to one host, provider, session, provider request, and offered choice.
4. Lost/retried network messages do not duplicate turns or replay approvals.
5. One provider failure does not grant access to another provider.
6. Untrusted JSON is validated before dispatch.

## Trust boundaries

- **Development host:** trusted to run Agent Bridge and provider tools. It can access the selected project directories and provider login state.
- **Paired device:** trusted only after possession of its private Ed25519 key and a current host-signed credential.
- **Relay:** routing infrastructure. It knows host/device identifiers and carries message content. It is not trusted to authorize actions.
- **Provider process:** separately trusted according to its own documented sandbox, approval, and account model.
- **Network:** untrusted. Use TLS outside loopback/LAN development.

## Provider credentials

Adapters use documented provider surfaces. They do not steal browser cookies, scrape private OAuth files, or copy provider credentials to a phone or relay.

Phone dictation uses a separately configured, documented speech-to-text API only when the host operator explicitly supplies `TETHOQ_OPENAI_API_KEY` for OpenAI speech-to-text or `XAI_API_KEY` for xAI speech-to-text to Tethoq Bridge. These credentials remain on the host and are never included in pairing data, device responses, or relay configuration. Source discovery exposes readiness and upload capabilities, never key values. Dictation source selection is independent of the active chat harness; Tethoq does not reuse harness login state or private authentication files for transcription.

Provider-owned configuration mutation is disabled unless the host operator sets `TETHOQ_ALLOW_PROVIDER_CONFIG_MUTATION=1`. Without that opt-in, Tethoq does not run Codex MCP add/remove commands or write an OpenCode tool into the user's configuration directory. Undocumented local-state readers are independently disabled unless `TETHOQ_ENABLE_CODEX_LOCAL_STATE=1` or `TETHOQ_ENABLE_OPENCODE_LOCAL_STATE=1` is set. These flags permit host-local access only; their data is still subject to the normal bridge response and event boundaries. Legacy `UAR_*` names are compatibility fallbacks.

- Codex App Server owns Codex authentication and documented login flows.
- OpenCode owns its model-provider credentials; optional Basic Auth protects the OpenCode HTTP server itself.
- Grok Build advertises ACP authentication methods.
- Direct API keys are accepted only through explicit endpoint configuration or
  host environment variables. Persisted keys are AES-256-GCM encrypted with
  host-identity-derived key material and never returned by wallet status.

The Direct API model picker can display its conservative built-in seed entries
without a credential. It does not contact a third-party model catalog until a
key for that endpoint has been configured. Catalog failure after configuration
falls back to the seed entries instead of weakening credential handling or
probing another service.

Never put provider API keys in `bridge.json`, pairing payloads, relay tokens,
connector manifests, or client-visible responses. Protect the host profile:
the bridge identity that derives Direct API key encryption is stored on that
same host, so this design protects accidental disclosure at rest but is not a
defence against a process or account that can read both local files.

The blue Direct API wallet is not a custodial wallet. CrofAI credit is read
from its documented provider endpoint. Every other configured balance is a
local application-side spend budget and may be reduced using token usage and
available catalog pricing; it is neither provider credit nor stored money.

## Pairing and credentials

The host generates an Ed25519 keypair. Pairing uses a random 256-bit secret with a short expiry and an independent six-digit display code. A successful confirmation registers the device public key and returns a host-signed credential containing host ID, device ID, credential ID, and issue time.

Host private keys are stored in the bridge configuration. The JSON store writes new files with `0600` and parent directories with `0700` on systems that honor POSIX modes. On Windows, protect the user profile and consider moving host keys to an OS credential store in a production hardening milestone.

The Flutter client stores its private key, credential, endpoint, and relay token through `flutter_secure_storage`. Validate actual Keychain/Keystore configuration on every target platform.

## Signed actions and replay protection

Each request has:

- A unique action ID.
- Issue and expiry timestamps.
- The complete inner bridge request.
- The host-signed device credential.
- An Ed25519 signature from the paired device.

The bridge rejects invalid signatures, wrong hosts, revoked/unregistered credentials, expired actions, excessive future skew, repeated action IDs, malformed envelopes, and wrong target hosts.

Opening Tethoq Desktop remotely is also a signed, explicit paired-device
action. The request carries no command, path, arguments, port, or environment.
The active Bridge can launch only the fixed Desktop executable configured by
its installed distribution, then confirms readiness through a loopback-only
HTTP endpoint whose random 256-bit route token is stored in a user-scoped file.
The token is never placed on an argument vector, returned to the phone, or
written to logs. Status probes use a short timeout and wake waits are bounded.

The device signs a canonical JSON envelope. Node (`canonicalizeJson` in
`packages/protocol/src/pairing.ts`) and the Flutter client (`canonicalJson` in
`apps/remote_client/lib/src/json.dart`) share one byte-exact canonical form (recursively
sorted keys, JSON.stringify number formatting) and both reject non-finite numbers and whole
numbers outside the JavaScript safe integer range (2^53-1). This prevents the two languages
from silently serializing the same value differently and producing a signature that only one
side accepts. Shared vectors in `packages/protocol/test_vectors/` lock this contract in tests
on both sides.

Request and send-message ledgers add semantic idempotency after cryptographic replay checks. Pairing confirmation itself is idempotent only for the same device identity.

### Send idempotency is a bridge-level property (validated live 2026-08-08)

Codex App Server `turn/start` accepts `clientUserMessageId`, but repeating `turn/start` with
the same id starts a second turn; the field is a correlation id, not a dedupe key. The Agent
Bridge `RequestLedger` is therefore the only boundary that prevents a duplicate real turn, and
it is in-memory per bridge process. Consequences to preserve in any hardening work:

- A bridge restart between an accepted send and a client retry can allow the same
  `requestId` to reach the provider again. A durable send ledger or provider-side dedupe key
  is required before treating send idempotency as crash-safe.
- The Flutter client must keep retrying only within one bridge lifetime, or use fresh
  request IDs after reconnect.

## Approvals

The normalized approval request preserves available provider context: host, project/session, provider, command, working directory, affected files, network destinations, reason, risk metadata, and exact provider choices.

The response path verifies that:

- the request is pending and unresolved;
- it belongs to this host;
- it is not expired;
- the selected choice was actually offered;
- the provider supports approval responses.

There is no generic “approve forever” action. OpenCode's adapter intentionally exposes approve-once and reject even though the provider has a broader persistent option. ACP/Grok choices keep their exact native option IDs. Codex exposes only decisions its App Server request offered.

## Transport

### Direct

The built-in direct listener is plain WebSocket by default and binds to loopback. `--allow-unsigned-local` is a development escape hatch and must not be exposed to untrusted networks. For LAN/remote use, terminate TLS and use `wss://`, or place the listener behind a private authenticated tunnel.

### Relay

The bridge initiates the outbound connection, so no unauthenticated public host port is required. Relay room tokens must contain at least 32 characters and should be random, unique per host, rotated, and delivered only through a protected channel.

Current relay security properties:

- Timing-safe comparison of token digests.
- One active host tunnel per host ID.
- One active tunnel per device ID.
- Heartbeats, attachment timeout, payload limits, message/byte rate limits.
- Device actions are still checked by the host.

Current relay limitations:

- Payloads are signed but not application-layer encrypted. TLS endpoints can read session content.
- A room uses one shared token across devices. Revoking a device credential blocks host actions, but a device holding the room token may retain relay connectivity until token rotation or a future per-device relay ACL is deployed.
- The relay is in-memory and single-process; there is no durable room registry, audit log, multi-region routing, DDoS layer, or production identity provider.
- TLS is expected from a reverse proxy/deployment layer and is not terminated by the Node process.

These limitations make the relay a secure foundation for development and controlled deployment, not a finished Internet-scale service.

## WebSocket parser hardening

The dependency-free WebSocket server validates upgrade headers, enforces the configured path, requires client masking, handles fragmentation/control frames, rejects unsupported binary content where appropriate, bounds message size, and implements close/ping/pong behavior. Fuzzing and independent protocol review remain recommended before production exposure.

## Session transfers and image retrieval

Context handoff and branch state is restart-local. Agent Bridge and Desktop
write `session-transfers.json` beside the selected configuration file using the
same atomic restricted-file store as other host state. The file is not
encrypted and is not synchronized to another host, provider, or device.

The store retains the source relationship and pending-bootstrap flag. A handoff
retains its visible deterministic summary; its optional captured prompt is
removed after the first provider-accepted send. A generic branch retains a
client-visible copy of the source conversation so it can be restored after a
restart. Before that copy is written, private reasoning and native metadata are
removed, inline binary/data-URI image payloads are omitted, and embedded data
URIs in text and structured tool fields are redacted. The remaining user text,
assistant text, tool/command output, file changes, paths, errors, and attachment
names may still be sensitive. Protect or delete the host-local file according
to the workspace's data policy.

Large inline history images are held in a bounded in-memory cache and exposed
through opaque, session-bound `session.image.get` identifiers. IDs expire after
five minutes of inactivity, cannot select another session's image, and never
cause the Bridge to fetch an arbitrary URL. This bounds response envelopes; it
does not add content encryption. For remote clients, image chunks still travel
through the normal signed request and TLS/relay trust boundary, so a relay or
TLS terminator that can read other session content can read them too.

## Data retention

- Harness session history remains in provider-owned storage. Direct API
  transcript history is persisted by Tethoq because these endpoints are
  otherwise stateless; it is local restricted JSON but is not encrypted.
- Agent Bridge keeps normalized session/message/event state in memory, plus
  host, paired-device, Direct API configuration, and the narrow
  `session-transfers.json` restart state described above on disk.
- The relay keeps rooms and rate counters in memory and does not intentionally persist content.
- The Flutter client stores pairing credentials and drafts; durable encrypted history is not implemented.

## Desktop and Bridge process ownership

Tethoq Bridge is an independent tray application. Hiding or closing Tethoq
Desktop does not terminate Bridge, and hiding the Bridge window does not stop
its engine. A single-instance lock prevents multiple Bridge companions from
owning the same local listener.

The current Desktop runtime still owns its in-process provider adapters and
external-connector registry. The bundled companion owns the mobile Bridge
runtime separately. Desktop therefore includes the real Bridge application
but does not silently auto-start it alongside Desktop until the provider and
connector state migration is complete; doing so today could duplicate provider
processes. A future cutover must move Desktop onto one authenticated local
Bridge client before removing the in-process runtime. Do not describe the
current release as unified provider ownership.

## Production hardening checklist

- Deploy relay and direct endpoints behind TLS with strict origin/network controls.
- Replace shared relay room tokens with per-device authorization and explicit relay revocation.
- Add end-to-end payload encryption if the relay/TLS terminator must not see content.
- Store host private keys in platform credential stores.
- Move persisted Direct API keys to an OS credential store and separately
  encrypt direct transcript and session-transfer history where the deployment
  requires it.
- Add structured security audit logs without prompt/secret leakage.
- Add CSRF/origin controls if a browser client is enabled.
- Perform dependency, static, fuzz, and external security review.
- Test macOS, Windows, Linux, iOS, and Android permission/storage behavior.
- Define emergency host/device revocation and token rotation operations.
