# Architecture

## Goal

The system presents coding-agent sessions from multiple computers and providers as one normalized remote experience:

> Open app → see agents → control agents.

Provider credentials stay on each development computer. Remote-device pairing is a separate security layer and does not claim that a provider account can discover arbitrary hosts.

## Components

### Remote Client

`apps/remote_client` is a Flutter application. It stores each paired host credential in platform secure storage, opens a direct or relay WebSocket, signs every post-pairing request, maintains reconnect/backoff state, deduplicates live events, preserves composer drafts, and renders provider-neutral sessions and timelines.

The UI reads capability records before enabling operations. A provider can therefore support session history without approvals, or approvals without model enumeration, without fake parity.

### Agent Bridge

`apps/agent_bridge` runs on macOS, Windows, or Linux under modern Node.js. Its responsibilities are:

1. Instantiate configured adapters and tolerate unavailable providers.
2. Normalize provider sessions, messages, events, approvals, and requested input.
3. Page complete session indexes and reconcile a local cache.
4. Route retry-safe requests to the correct native session.
5. Preserve provider-native IDs and metadata.
6. Keep provider authentication on the host.
7. Verify paired-device credentials and signed actions.
8. Serve direct WebSocket clients and create an outbound relay tunnel.

A provider process failure is isolated. Refresh marks only that provider's cached sessions stale/disconnected while preserving successful provider results.

On Windows, the distributable Bridge is wrapped by the compact
`apps/desktop_companion` Electron tray shell. The shell and its engine are an
independent application: window close means hide, while explicit tray Quit
owns shutdown. A Desktop installation includes this same companion so users do
not need a second download; Bridge-only remains separately installable for a
phone-first setup.

The current Desktop runtime still owns a separate in-process adapter runtime.
It must not auto-start the companion during normal Desktop launch until the
remaining connector/config state is migrated to one Bridge owner. The target
end state is Desktop as an authenticated local Bridge client, never two
simultaneous adapter owners.

### Relay

`services/relay` accepts outbound host and device WebSockets. A room is keyed by `hostId` and a high-entropy token. The relay routes device payloads to the host and host payloads to the addressed device, enforces heartbeat/size/rate limits, and notifies devices when a host tunnel disappears.

The relay is not an approval authority. Host-side verification still requires a valid host-signed device credential, an unexpired Ed25519 action signature, and a fresh action ID.

Both roles authenticate at attachment. The room token is shared with every paired device, so it is a routing hint rather than a credential: a host signs with its Ed25519 identity and the relay pins that key for the room, and a device presents its host-signed credential and signs with the key inside it. The relay therefore learns the device ID the host issued rather than the one the client claimed, which stops a paired phone claiming the host role or a sibling's identity.

Revocation closes connections rather than only refusing actions. The host names revoked devices when it attaches and whenever a revocation happens; the relay drops any live tunnel for them and refuses their reattachment even though the room token is shared. The relay stores nothing durably, so the host re-publishes that list on every attach.

Payloads are encrypted end to end between the host and the paired device, so a relay operator routes ciphertext it cannot read. Each connection agrees a fresh key by signed ephemeral X25519 exchange: the host signs its ephemeral key with the host identity, the device signs its own with the key inside its host-signed credential, and both signatures cover the full transcript so a substituted key cannot go unnoticed. Keys are derived per direction with HKDF-SHA256 and used with AES-256-GCM under a monotonic frame counter, which also rejects a replayed or reordered frame. Because the keys are ephemeral, recorded traffic stays unreadable even if a device key later leaks. Only relay routing fields stay in clear text. TLS remains required in any non-local deployment.

## Provider boundary

`packages/provider_contract` defines the common adapter contract. Operations that are not universal remain optional. Each adapter reports a `ProviderCapabilities` record that drives bridge and client behavior.

Harness adapters leave authentication in the installed harness. The aggregate
`direct` adapter is the explicit exception: it accepts a user-owned API key for
a selected documented HTTPS endpoint, encrypts that key in host-local state,
and exposes neither the key nor a reusable credential through the normalized
protocol.

The normalized ID is built from three separately encoded components:

```text
hostId/providerId/providerSessionId
```

The exact implementation safely round-trips separators and Unicode, so native IDs cannot collide across hosts or providers.

## Refresh flow

```text
client sessions.refresh
  -> bridge coalesces concurrent refresh calls
  -> every adapter is queried independently
  -> each cursor is followed until exhausted
  -> successful provider results reconcile the cache
  -> failed provider cache entries become stale/disconnected
  -> one aggregate RefreshResult returns sessions + per-provider results
```

The result includes start/completion timestamps, pages fetched, counts, newly discovered sessions, per-provider failures, and the last time at least one provider refreshed successfully.

## Live event flow

Provider callbacks are normalized into an `AgentEvent` stream. The bridge assigns monotonically increasing host-local sequence numbers and keeps a bounded replay buffer. A connection emits `event.batch` envelopes. The client tracks both event IDs and the latest sequence to suppress duplicates and request reconciliation after a gap.

Important normalized event groups:

- Session lifecycle and state.
- Incremental message text.
- Tool, command, and file-change activity.
- Approval and user-input requests.
- Agent completion, interruption, and errors.
- Host/provider connectivity.

Provider-native metadata travels beside normalized payloads when discarding it would lose context or security details.

## Approval and user-input binding

The bridge creates a fresh normalized request ID and stores the exact tuple:

```text
host + provider + global session + provider request + offered choices
```

A response is accepted only while pending, unexpired, directed to the correct host, and using an offered choice. The registry marks the request resolved before calling the provider, rolls back only if the provider call fails, and rejects stale replay.

User-input requests use the same exact-binding model and require at least one answer.

## Reconnect and idempotency

- Transport reconnect uses exponential backoff with bounded jitter.
- WebSocket ping/pong detects dead connections.
- Request IDs are stable across retries.
- The bridge request ledger is shared across connection instances for the same bridge.
- Message submission has a second bridge-level ledger so a transport retry cannot duplicate a provider turn.
- Pairing confirmation is idempotent for the same device key after a lost response.
- Event replay and client-side event-ID deduplication handle duplicate/out-of-order delivery.

## Persistence

Host configuration, pairing state, and Direct API state use atomic
temporary-file replacement. Directories are created with mode `0700` and newly
written files with mode `0600` on platforms that honor POSIX modes. Direct API
keys are AES-256-GCM encrypted using host-identity-derived key material; direct
session transcripts and local spend-budget metadata remain ordinary local JSON
inside that restricted file. The Flutter client stores device private keys,
host credentials, and relay tokens through `flutter_secure_storage`.

The normalized cross-provider session cache is in memory. Durable encrypted
message/session caching is a later milestone. Harness providers remain the
source of truth after process restart; the Direct API adapter persists the
transcript needed to continue its own stateless API conversations.

## Technology choices

- Flutter/Dart for cross-platform client UI.
- TypeScript on Node.js 22.13.0 or newer for bridge and relay.
- JSON over authenticated WebSocket with protocol version 1.
- JSON-RPC/JSON Lines only inside adapters that use provider protocols.
- Ed25519 from established Node/Dart cryptography libraries.
- No visual UI scraping.
