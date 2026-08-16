# Build status

Updated: **2026-08-16**

Status values: `COMPLETE`, `IMPLEMENTED_UNTESTED`, `PARTIAL`, `BLOCKED_LOCAL`, `BLOCKED_CREDENTIALS`, `RESEARCH_ONLY`, `NOT_STARTED`.

| Area | Status | Tested? | Notes |
|---|---|---:|---|
| Repository/workspace/build scripts | COMPLETE | Yes | Strict TypeScript build, lockfile, CI, clean/test/quality scripts. Quality gate now runs on Windows (`fileURLToPath` fix). |
| Normalized protocol models | COMPLETE | Yes | Hosts, connections, capabilities, sessions, relationships, handoff/branch results, top-level handoff summaries, messages, image-retrieval IDs, events, approvals, input, models, context/usage, wallet status/configuration, visual support, errors, refresh. |
| Global session IDs | COMPLETE | Yes | Three separately encoded components; Unicode/separator test. |
| Wire envelopes/runtime validation | COMPLETE | Yes | v1 requests/responses/events/hello, JSON object validation, unknown-version rejection. |
| Published JSON Schema | COMPLETE | Yes | `packages/protocol/schema/protocol-v1.schema.json`. |
| Event replay/deduplication | COMPLETE | Yes | Sequence IDs, bounded replay, duplicate and out-of-order tests. |
| Request/message idempotency | COMPLETE | Yes | Shared request ledger and provider send ledger. Verified live that Codex itself does NOT dedupe `clientUserMessageId`; the bridge ledger is the real boundary. |
| Pairing/device credentials | COMPLETE | Yes | Ed25519, expiry, idempotent confirm, persistence, revocation. |
| Signed action/replay validation | COMPLETE | Yes | Host credential + device action signature, expiry/skew/replay checks. |
| Cross-language signing vectors | COMPLETE | Yes | `packages/protocol/test_vectors` consumed by Node and Flutter tests: canonical JSON byte-matches, host/device signatures verify across Node <-> Dart, unsafe numbers rejected by both. |
| Provider adapter contract | COMPLETE | Yes | Optional capability methods and typed shared errors/events. |
| Fake provider | COMPLETE | Yes | 175 sessions, pagination, stream, tools, commands, approval/input, failures/offline/duplicates. |
| Refresh subsystem | COMPLETE | Yes | Full pagination, coalesced refresh, reconciliation, partial failure/stale data. |
| Approval subsystem | COMPLETE | Yes | Exact host/provider/session/provider-request/choice binding. |
| User-input subsystem | COMPLETE | Yes | Exact binding and non-empty answer validation. |
| Codex adapter | COMPLETE | Yes | Validated against installed `codex-cli 0.147.0`: initialize/account/model/thread/turn/events all matched the generated schema. Approval/input responses reconciled per request kind. Windows `.cmd` spawn fixed. |
| Codex wire types/fixtures | COMPLETE | Yes | Curated `wire.ts` updated from `codex app-server generate-ts` for 0.147.0; live responses cross-checked. |
| Codex local opt-in integration tests | COMPLETE | Yes | `local_integration.test.ts` + bridge `local_codex_integration.test.ts` skipped unless `TETHOQ_CODEX_INTEGRATION=1`; both green against the real server. |
| OpenCode adapter | IMPLEMENTED_UNTESTED | Fixtures/SSE only | HTTP/SSE implementation; real server absent. Native list is locally paginated. |
| Pi / OMP adapters | IMPLEMENTED_UNTESTED | Deterministic RPC peers only | Strict LF-delimited native RPC, runtime-owned sessions, usage/context/cost, compaction, Pi extension delivery, and OMP host tools. No live model or installed-harness smoke was run. |
| Shared ACP adapter | IMPLEMENTED_UNTESTED | Deterministic ACP peers only | Capability-gated ACP v1 presets for Grok Build, Qwen Code, goose, Kimi Code, Hermes Agent, Cline, and GitHub Copilot CLI. Optional provider-reported usage metadata is preserved; absent fields remain unavailable. No live model turn was run. |
| Direct API adapter | IMPLEMENTED_UNTESTED | Deterministic injected HTTP only | Aggregate user-key provider with OpenAI Responses, compatible Chat Completions, endpoint-prefixed models including Google Gemini 3.6 Flash BYOK, credential-gated catalog discovery, encrypted local keys, host-local transcripts, image/tool loops, local spend budgets, CrofAI credit parsing, and custom HTTPS endpoints. No live API request was made. |
| Built-in provider discovery | COMPLETE | Yes | Twelve independent entries: eleven harnesses (Codex, OpenCode, Grok Build, Pi, OMP, Qwen Code, goose, Kimi Code, Hermes Agent, Cline, and GitHub Copilot CLI) plus Direct API. A missing executable affects only its harness entry; Direct seed models remain visible with a missing-key caution and no third-party catalog probe. |
| Session context and compaction | COMPLETE | Yes | Harness-reported usage/cost, Direct API usage plus explicitly local priced spend, 5%-rounded threshold minimum, model-window maximum, immediate-compaction confirmation, and after-turn automatic compaction are covered by deterministic tests. ACP compaction stays unavailable; Direct compaction is a local transcript summary. |
| Desktop/mobile context UI | IMPLEMENTED_UNTESTED | Component/store tests | Horizontal context usage, cost details, unavailable states, threshold slider, and full immediate-compaction confirmation are implemented; packaged/manual interaction QA remains pending. |
| Session context handoff and branching | COMPLETE | Yes | Fresh same-provider sessions, deterministic 100-1000 word handoff summaries without a model call, top-level summary metadata, exactly-once first-send bootstrap, native Codex fork, bounded generic transcript fallback, restart restoration, and sanitized persisted branch copies are covered by deterministic tests. |
| Desktop/mobile handoff and branch UI | IMPLEMENTED_UNTESTED | Source/store/widget tests | Both clients expose handoff/branch actions; the context-handoff composer includes dictation, editable drafts, a visible muted summary, and selection of the new task. Packaged Desktop and physical-device interaction QA remain pending. |
| Large history image transport | COMPLETE | Yes | Oversized inline data images become opaque session-bound retrieval IDs and reconstruct byte-for-byte through bounded short-lived chunks. |
| Desktop/mobile image UI | IMPLEMENTED_UNTESTED | Source/store/widget tests | Desktop paste and screen-region attachments plus Desktop/mobile inline previews, expansion, and chunk hydration are implemented. Packaged/manual capture and physical-device QA remain pending. |
| Session browser tools | IMPLEMENTED_UNTESTED | Deterministic browser-tool tests | Session-isolated tabs, bounded inspection/capture, and semantic-reference click/type are implemented without arbitrary caller selectors or page scripts. Real signed-in workflow testing remains pending. |
| Visual-support helper | IMPLEMENTED_UNTESTED | Bridge/client tests | Native image capability is preserved; text-only sessions can use an explicitly configured helper and otherwise receive an unavailable result. No live vision turn was run. |
| Provider compatibility glyphs | COMPLETE | Yes | Provider rows use original Tethoq glyph themes rather than copied provider logos; asset/provenance policy is documented. |
| Direct WebSocket transport | COMPLETE | Yes | Real local handshake, signed requests, heartbeat path. Production TLS external. |
| Relay foundation | PARTIAL | Yes | Routing/auth/limits/reconnect tested; shared token, no E2E encryption, single process. |
| Host config/pairing persistence | COMPLETE | Yes | Atomic writes and restrictive POSIX modes. |
| Flutter application source | COMPLETE | Yes | `flutter analyze` is clean, the current Flutter suite passes, and an Android debug APK builds, installs as an in-place update, and launches on a physical Android 16 device. Full release interaction QA remains outstanding. |
| Flutter native launchers | PARTIAL | Yes | Android and Windows launchers are checked in; the Android debug build and physical-device launch are green. iOS/macOS/Linux launchers and full release QA remain outstanding. |
| Flutter web transport | NOT_STARTED | No | Current client uses `dart:io`; add conditional browser WebSocket implementation first. |
| Session list/filter UI | IMPLEMENTED_UNTESTED | No | Provider/status/search filters and recent-activity sort. Host filter is implicit in active host, not multi-host aggregation. |
| Session timeline/composer | IMPLEMENTED_UNTESTED | Source/widget tests | History, events, drafts, send/interrupt, image previews, and transfer summaries are implemented. |
| New-session UI | IMPLEMENTED_UNTESTED | Component/store tests | Desktop provides provider/directory/model/effort/first-instruction controls from `models.list`; mobile starts with the selected harness default and exposes advertised model changes inside the session. |
| Model picker and wallet UI | IMPLEMENTED_UNTESTED | Source/store/widget tests | Provider grouping, five recents, live search, Desktop's larger in-app model browser, missing-key caution, endpoint-aware Direct configuration, and explicit harness/subscription/user-wallet treatments are implemented. Packaged/manual interaction QA remains pending. |
| Approval/user-input UI | IMPLEMENTED_UNTESTED | No | Context cards and exact choices/answers. |
| Host/provider management UI | PARTIAL | No | Pair/remove/revoke/reconnect/status. Direct API wallet/key configuration is separate; no generic remote harness-authentication UI yet. |
| Multi-host aggregate view | PARTIAL | No | Multiple credentials stored; UI activates one host at a time. |
| QR camera pairing | PARTIAL | Yes | The mobile scanner, validated pairing payload flow, and focused QR tests are implemented; physical-camera pairing QA remains outstanding. |
| Website account and Google OAuth foundation | PARTIAL | Source tests | Environment-driven Supabase email/Google flows, callback handling, user/workspace bootstrap, RLS, dashboard, and revocation UI exist. The community source tree includes no hosted project or credentials; a deployer must supply public environment values and configure provider redirects before sign-in is usable. |
| Native account sign-in | NOT_STARTED | No | Phone and Desktop do not yet authenticate to the Tethoq account service. Phone entry remains QR pairing; Desktop local use remains intentionally account-free. |
| Account-backed no-QR enrollment | NOT_STARTED | No | Requires authenticated computer registration, device-key enrollment, explicit first-device approval, per-device relay authorization, revocation, and audit. Google login alone must not authorize Bridge actions. See `docs/ACCOUNT_ACCESS.md`. |
| Community/hosted distribution boundary | RESEARCH_ONLY | Documentation | Product boundary is decided: community defaults to account-free local/QR use; official builds add optional account-gated cloud access without gating the local app. Build-time adapters and release configuration are not implemented yet. |
| Durable encrypted session cache | NOT_STARTED | No | General session/event cache is in memory and provider history remains authoritative. Narrow exceptions are Direct API transcripts and restart-local `session-transfers.json`; both are restricted local JSON, not an encrypted general cache. |
| Production relay deployment | NOT_STARTED | No | Needs TLS deployment, per-device relay auth, durable routing/audit/operations. |
| Real Codex end-to-end vertical slice | PARTIAL | Yes | Bridge + real Codex slice green: pair/refresh/open/models/send-once/live events/idempotent retry/cleanup. Real approval, user-input, and interrupt not yet triggered live; Flutter client compiled and unit-tested but not yet connected to the real bridge. |
| macOS/Windows/Linux provider testing | PARTIAL | Yes | Windows bridge/codex path now exercised; macOS/Linux provider processes still untested. |
| Physical iOS/Android testing | PARTIAL | Yes | The debug APK was installed as an in-place update and launched without a startup crash on a physical Samsung SM-S938B running Android 16. Secure-storage migration, background lifecycle, live Bridge handoff, QR/camera pairing, and iOS remain separate release gates. |
| Provider research | COMPLETE | N/A | Official docs/repos and dated issue-report caveats cover all twelve built-ins (eleven harnesses plus Direct API) and the Claude Code, Gemini CLI, Cursor, Aider, Crush, and Kilo Code exclusions/deferments. |
| Security architecture documentation | COMPLETE | N/A | Includes relay/confidentiality limits, harness-process authority, credential-gated catalog discovery, session-transfer persistence/sanitization, short-lived image retrieval, browser prompt-injection risk, cross-provider screenshot disclosure, and the live send-idempotency finding. |
