# Engineering decisions

## D-001 — Keep the requested technology stack

**Decision:** Flutter/Dart client; TypeScript on Node.js bridge/relay; JSON over versioned authenticated WebSocket.

**Reason:** All four provider surfaces can be adapted on Node without changing the client stack. No evidence justified a rewrite.

## D-002 — Capability-driven adapter contract

**Decision:** Keep optional operations optional and publish a complete `ProviderCapabilities` record.

**Reason:** Provider parity is materially different. A mandatory “fake success” implementation would hide security and product limitations.

## D-003 — Codex first through App Server stdio

**Decision:** Implement Codex App Server over documented JSON Lines/stdio first; do not use the experimental provider WebSocket by default.

**Reason:** Stdio is documented, local, typed, and keeps provider credentials on the host.

## D-004 — Provider-native IDs are never global IDs

**Decision:** Encode host ID, provider ID, and native session ID as three collision-safe components.

**Reason:** Native IDs can collide and can contain separators/Unicode.

## D-005 — Complete refresh with partial failure

**Decision:** Fetch every provider page independently, reconcile successes, and mark only failed-provider cache entries stale.

**Reason:** One unavailable provider must not erase usable sessions from another.

## D-006 — Two layers of idempotency

**Decision:** Deduplicate bridge requests by request ID and separately deduplicate provider message submission.

**Reason:** A socket can disconnect after provider acceptance but before the response reaches the phone.

## D-007 — Host-signed credential plus device-signed short-lived action

**Decision:** Use Ed25519, credential revocation, expiry, clock-skew limits, and action-ID replay tracking.

**Reason:** The relay must not be able to fabricate approvals. Established primitives are available in Node and Dart.

## D-008 — Signatures are not called encryption

**Decision:** Require TLS for confidentiality and document that relay/TLS endpoints can read content.

**Reason:** Device signatures authenticate actions but do not hide session data.

## D-009 — OpenCode persistent approval omitted

**Decision:** Expose approve-once and reject, not the provider's `always` option.

**Reason:** Persistent approval needs a separate explicit risk model; the MVP must not casually widen authority.

## D-010 — Grok/ACP capabilities are negotiated

**Decision:** Read list/load/resume/model support from `initialize` and fail unsupported operations explicitly.

**Reason:** ACP methods are capability-gated and agent versions/modes differ.

## D-011 — First-party provider boundary

**Decision:** Ship only the twelve researched built-in compatibility entries:
Codex, OpenCode, Grok Build, Pi, OMP, Qwen Code, goose, Kimi Code, Hermes
Agent, Cline, GitHub Copilot CLI, and the aggregate Direct API provider. Keep
the public connector protocol provider-neutral, while treating every
user-installed connector as independent executable code that requires
fingerprint approval.

**Reason:** Each built-in has a current first-party machine interface suitable
for a rich client, or, for Direct API, a documented user-key HTTPS request
surface. Copilot CLI ACP is explicitly documented for custom frontends and
multi-agent systems, although it remains public preview. Claude Code remains
permission-gated; Gemini CLI's official terms warn against the third-party
access path; and candidates without a dependable rich lifecycle remain
deferred. Provider-specific authentication and service terms still belong to
the provider and user.

## D-012 — Dependency-free host WebSocket server

**Decision:** Implement the required RFC 6455 server subset using Node core.

**Reason:** Package-registry access was unavailable in the build environment, while Node's client WebSocket and core HTTP/crypto APIs were available. Tests cover handshake, masking, text round trips, pong tracking, path rejection, relay routing, and limits. Independent fuzz/security review is still required before production exposure.

## D-013 — Flutter source before native launchers

**Decision:** Build the Dart application, tests, and dependency manifest, then leave platform launcher generation to local Flutter.

**Reason:** Flutter/Dart were absent here. Generating fake launcher files would be less trustworthy than the exact `flutter create` continuation command.

## D-014 — In-memory session cache for bootstrap

**Decision:** Persist pairing/identity, but keep normalized session/event cache in memory.

**Reason:** Harness-provider history remains authoritative. Direct HTTPS APIs
are stateless for this adapter, so Direct sessions persist only the transcript
needed to continue them in their separate host-local state. A general durable
encrypted cache still requires a migration/storage/privacy design.

## D-015 — Usage provenance stays explicit

**Decision:** Display context, token, and monetary usage only when the active
harness/API reports the underlying usage. Harness monetary values remain
harness-reported only. A Direct API session may calculate spend from known
per-token catalog pricing, but it must remain local accounting rather than an
authoritative balance or invoice. Render missing values as unavailable.

**Reason:** Token accounting, cache semantics, discounts, currencies, context
estimates, and subscription quotas differ by provider. A plausible unlabeled
estimate would be misleading in a per-session control surface.

## D-016 — Compaction thresholds are bounded and turn-safe

**Decision:** Enable the threshold slider only when the adapter exposes a safe
compaction operation and the active model's context limit is known. Harnesses
use native compaction; Direct API uses an explicit local transcript summary.
Bound the threshold to the reported window and a 5%-rounded minimum. A
threshold at or below current usage requires a full confirmation and compacts
immediately; ordinary automatic compaction runs after `agent.completed`.

**Reason:** This prevents impossible model-window settings and avoids
interrupting a normal turn without an explicit user decision.

## D-017 — Browser automation uses semantic references

**Decision:** Expose session-scoped open/navigate/inspect/click/type/scroll and
capture tools. Click/type accept only fresh semantic references produced by
inspection; the tool surface accepts no arbitrary page script or caller CSS
selector.

**Reason:** Models need a consistent browser workflow across harnesses, but an
unbounded renderer execution primitive would create a much larger and less
reviewable authority surface.

## D-018 — Visual support is an explicit helper model

**Decision:** Use native image input when capability is known. Otherwise route
an attachment or browser capture only to a user-configured visual-support
model and return its text observation to the primary session.

**Reason:** A text-only model must not be told it saw pixels it never received,
and sending screenshots to another provider is a data disclosure that requires
an explicit configured target.

## D-019 — Original compatibility glyphs

**Decision:** Use textual compatibility names and original Tethoq glyphs; do
not bundle, trace, recolor, or imitate provider logos.

**Reason:** Nominative labels identify interoperability. Original artwork
avoids implying endorsement and avoids depending on third-party trademark or
brand-asset permission.

## D-020 — Direct API wallet is non-custodial

**Decision:** Treat the blue user wallet as an API funding-source indicator.
Show provider credit only when an official endpoint supplies it (currently
CrofAI). Otherwise expose an optional host-local spend budget/cap, never a
Tethoq-held balance. Encrypt persisted API keys and never return them through
wallet status.

**Reason:** Tethoq does not process payments, hold funds, or control the
provider's billing ledger. Clear provenance prevents a local estimate from
being mistaken for money, provider credit, or a guaranteed billing stop.

## D-021 — Accounts unlock hosted access, not the local app

**Decision:** Keep desktop and local-agent use account-free in every edition.
The official build requests an account only when a user chooses hosted
discovery, enrollment, relay, or synchronization. The open-source community
build defaults to no Tethoq account dependency and retains direct/LAN and QR
pairing. Account-backed discovery may remove the QR scan, but every phone still
uses a device key and a revocable Bridge-issued credential.

**Reason:** A mandatory login would weaken the local-first and open-source
product while creating an unnecessary outage/privacy dependency. Conversely,
equating a Google session with remote-control authority would collapse two
important trust boundaries. Separating account membership from device
authorization gives the official service a low-friction phone experience
without making the hosted control plane the final authority over local tools.
