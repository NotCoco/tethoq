# Bridge protocol v1

## Artifacts

- TypeScript envelopes: `packages/protocol/src/envelopes.ts`
- Runtime parser/validators: `packages/protocol/src/validation.ts`
- Normalized models/events: `packages/protocol/src/models.ts`
- Pairing and action signatures: `packages/protocol/src/pairing.ts`
- JSON Schema: `packages/protocol/schema/protocol-v1.schema.json`

The runtime parser is authoritative for executable behavior. The JSON Schema is a versioned interoperability artifact and is parsed by the test suite to prevent accidental omission.

## Base envelope

All normal bridge envelopes contain:

```json
{
  "protocolVersion": 1,
  "messageId": "uuid",
  "hostId": "host_uuid",
  "sentAt": "2026-08-07T12:00:00.000Z",
  "kind": "request | response | event | hello",
  "type": "operation.name"
}
```

Unknown protocol versions are rejected before routing. Payloads must be finite JSON values; functions, binary objects, `NaN`, and infinite numbers are rejected.

## Requests and responses

A request has a stable `requestId` and object payload:

```json
{
  "protocolVersion": 1,
  "messageId": "m1",
  "hostId": "host_a",
  "sentAt": "2026-08-07T12:00:00.000Z",
  "kind": "request",
  "type": "session.send_message",
  "requestId": "request-a",
  "payload": {
    "sessionId": "encoded-global-id",
    "content": "Run the tests"
  }
}
```

A response repeats the same `requestId`. `type` is the operation name plus `.result`. Errors are structured as `code`, `message`, `retryable`, and optional JSON details.

The bridge remembers completed/in-flight request IDs. Retrying the same ID returns the same response rather than executing the operation again. `session.send_message` also has provider-dispatch deduplication.

## Event batches

The bridge assigns each normalized event an `eventId` and host-local `sequence`. Connections receive batches:

```json
{
  "protocolVersion": 1,
  "messageId": "m2",
  "hostId": "host_a",
  "sentAt": "2026-08-07T12:00:01.000Z",
  "kind": "event",
  "type": "event.batch",
  "sequence": 42,
  "payload": { "events": [] }
}
```

`sync.since` accepts a non-negative sequence and returns replayable events plus the latest known sequence. Replay storage is bounded; a client that falls behind the retained window must reopen/refetch session state.

## Hello and version negotiation

A newly accepted bridge connection sends `protocol.hello` with its supported versions and role. Protocol v1 currently accepts only version 1. A future incompatible protocol must add a new schema and explicit negotiation rather than silently changing v1 fields.

## Signed device actions

After pairing, every device request is wrapped as:

```json
{
  "kind": "signed_action",
  "signed": {
    "credential": {
      "payload": "base64url-host-signed-json",
      "signature": "base64url-ed25519-signature"
    },
    "actionId": "unique-action-id",
    "issuedAt": "2026-08-07T12:00:00.000Z",
    "expiresAt": "2026-08-07T12:01:00.000Z",
    "action": { "protocolVersion": 1, "kind": "request" },
    "signature": "base64url-device-ed25519-signature"
  }
}
```

The host verifies:

1. Its own signature on the credential.
2. Credential host ID, registration, and revocation status.
3. Device signature over canonical JSON.
4. Issue/expiry timestamps and clock-skew bound.
5. Fresh `actionId` to prevent replay.
6. The inner request envelope and target host.

Signatures authenticate and authorize; they do not encrypt. Use `wss://` outside local development.

## Pairing

`pairing.start` creates a five-minute payload containing host ID/public key, a random 256-bit secret, pairing ID, six-digit human check code, expiry, and optional relay information. `pairing.confirm` supplies the secret and a device public key. A successful response is a host-signed device credential.

`pairing.confirm` may be sent unsigned because no credential exists yet. A consumed pairing can be retried only by the same device ID/public key, which makes a lost success response recoverable without opening the pairing to a second identity.

## Operations

Current request types:

| Area | Operations |
|---|---|
| Host/provider | `host.get`, `provider.list`, `provider.reconnect`, `provider.authenticate`, `models.list`, `wallet.get`, `wallet.configure` |
| Sessions | `sessions.refresh`, `sessions.list`, `session.open`, `session.image.get`, `session.create`, `session.context_handoff`, `session.branch`, `session.send_message`, `session.interrupt` |
| Security prompts | `approval.list`, `approval.respond`, `user_input.list`, `user_input.respond` |
| Reconciliation | `sync.since` |
| Optional Desktop UI | `desktop.status`, `desktop.wake` |
| Pairing/devices | `pairing.start`, `pairing.confirm`, `device.list`, `device.revoke` |

`wallet.get { providerId, modelId?, endpointId? }` returns funding-source kind, endpoint,
configured-key status, caution text, and only those balance/spend values whose
provenance is available. It never returns key material. `wallet.configure`
accepts the Direct API `endpointId` plus an optional new key, clear-key flag,
local balance update, or custom endpoint definition. Custom remote endpoints
must use HTTPS and declare `responses` or `chat_completions`; loopback HTTP is
the development-only exception. These operations do not turn the Bridge into
a payment processor or provider-credit authority.

### Context handoff and branch

Both transfer operations accept the same request payload:

```json
{ "sessionId": "source-global-session-id", "prompt": "optional continuation" }
```

`prompt` is optional, trimmed, and limited to 32,000 characters; when present,
it must not be empty. Both operations create a fresh session on the same host
and provider and preserve the source working directory, model, and reasoning
setting where available.

`session.context_handoff` returns:

```json
{
  "summary": "100-1000 word visible summary",
  "session": {
    "contextHandoffSummary": "the same visible summary",
    "relationship": {
      "kind": "handoff",
      "sourceSessionId": "source-global-session-id",
      "strategy": "summary_bootstrap"
    }
  },
  "prompt": "present only when supplied"
}
```

The summary is deterministic and generated from normalized history without a
model or paid summarization call. Creating the handoff does not start a model
turn. A supplied prompt is a captured continuation note; clients may use the
returned value to prefill the new composer. The summary, captured note, and
first actual user message are sent to the provider together as a hidden
bootstrap. The pending state is cleared only after the provider accepts that
send, so a failed send leaves it available for retry. Client-visible history
removes the bootstrap markers, while the top-level `contextHandoffSummary`
remains available after refresh and restart.

`session.branch` returns:

```json
{
  "session": {
    "relationship": {
      "kind": "branch",
      "sourceSessionId": "source-global-session-id",
      "strategy": "transcript_bootstrap"
    }
  },
  "strategy": "transcript_bootstrap",
  "copiedMessageCount": 12
}
```

`strategy` is either `native` or `transcript_bootstrap`. The bridge prefers an
adapter's native branch operation. Otherwise it creates a
new session and supplies the complete normalized transcript as a provider-only
bootstrap, capped at 1,000,000 bytes. Private reasoning and binary attachment
payloads are omitted, and historical tool output is explicitly quoted as
history rather than treated as a fresh instruction. A supplied branch prompt
is sent immediately; without one, the fallback bootstrap waits for the first
user message. The copied conversation remains visible to the client without
showing the provider-only bootstrap wrapper.

Agent Bridge and the Desktop runtime persist transfer relationships and pending
bootstrap state in the host-local `session-transfers.json` beside the selected
configuration file. This is restart continuity, not cross-host, cross-provider,
or device synchronization. Persisted generic branch copies remove private
reasoning, native metadata, and inline binary/data-URI payloads while retaining
the visible normalized record.

### Large inline image retrieval

When a `session.open` history page would otherwise contain a large inline
`data:image/*` value, the image part may contain an opaque `retrievalId` instead
of `uri`. An authorized client retrieves it in bounded chunks:

```json
{ "sessionId": "global-session-id", "retrievalId": "image_opaque-id", "offset": 0 }
```

`offset` defaults to zero. The response is:

```json
{
  "retrievalId": "image_opaque-id",
  "offset": 0,
  "totalBytes": 700000,
  "dataBase64": "...",
  "nextOffset": 491520,
  "mimeType": "image/png",
  "name": "optional-name.png"
}
```

Clients follow `nextOffset` until it is `null`. Chunks are at most 480 KiB;
nonzero offsets must be the previously returned aligned offset. Retrieval IDs
are random, bound to one session, stored only in memory, and expire after five
minutes of inactivity. Inline images larger than 25 MiB are not cached. An
expired image is recovered by reopening the session to obtain a new ID;
`session.image.get` never fetches an arbitrary remote URL.

`desktop.status {}` returns `{ state: "running" | "stopped" | "starting" }`.
`desktop.wake {}` is an explicit user action and returns
`{ state: "running" | "starting", launched: boolean }`. Both operations travel
through the same paired-device signature checks as coding actions. Wake accepts
an empty payload only: the Bridge chooses a fixed installed executable and
verifies an opaque loopback readiness route. A Bridge-only install reports
`stopped` and returns `DESKTOP_NOT_INSTALLED` from wake; it remains fully usable
for ordinary mobile coding operations.

Unknown operations fail closed.

## Relay framing

Relay control messages are separate from protocol envelopes:

- `relay.attach`: role, host ID, shared room token, and device ID where applicable.
- `relay.forward`: addressed payload string.
- `relay.attached` and `relay.host_offline`: relay status.

The relay routes payloads but the host remains the signer/verifier authority. Production deployment still needs TLS, access control, observability, and secret rotation.
