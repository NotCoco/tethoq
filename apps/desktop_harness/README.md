# Tethoq Desktop

Tethoq Desktop is the native Windows workspace for provider-neutral coding CLIs and compatible connectors. It keeps sessions, live output, approvals, requested input, message queues, attachments, provider health, and multi-provider delegation in one focused interface.

The desktop release ships trusted integrations for **Codex, OpenCode, Grok
Build, Pi, OMP, Qwen Code, goose, Kimi Code, Hermes Agent, Cline, GitHub
Copilot CLI, and Direct API models**. It also supports independently installed,
out-of-process connectors through the public `@tethoq/connector-sdk`. Tethoq
does not include, bundle, market, or author a Claude integration in this
release. The connector boundary remains provider-neutral; Tethoq supplies no
provider-specific setup or support for independent connectors.

Desktop keeps one provider adapter/transport per coding tool and reuses it
across that tool's sessions. Parallel-work and visual-support tools share one
authenticated local gateway; visual-only helper sessions explicitly start
without their own client-tool or MCP configuration. The gateway, its client
sockets, provider process trees, approved connector processes, and any
Tethoq-managed OpenCode server are all reaped during shutdown or failed
startup.

## In-app Chromium

The Browser workspace is native Chromium hosted in sandboxed Electron
`WebContentsView` tabs. It supports an address bar, tab creation and closing,
back/forward/reload/stop, normal browser shortcuts, context menus, downloads,
and explicit permission prompts.

Chromium is session-scoped and lazy: launching Tethoq, listing tasks, or using
recorded workflows does not create a browser tab or load a website. The first
explicit browser action in a coding session materializes the persistent view;
each session keeps only a bounded URL/title snapshot when another session takes
over. Hidden browser views are throttled immediately and hibernate after 30
seconds, closing their Chromium views and idle connections. A progressing
download defers hibernation until it finishes. Reopening reconstructs tabs from
the lightweight snapshot, while app shutdown closes everything.

Browser storage uses the dedicated persistent partition
`persist:tethoq-browser`. Users may sign into websites manually and keep those
cookies between launches. Tethoq does not inspect, import, or automatically
sign into an existing Chrome or Chromium profile, and the browser partition is
separate from coding-provider credentials. **Clear profile data** clears its
authentication cache, cookies/storage, cache, resolver cache, connections, and
tab navigation history; download-history clearing does not delete downloaded
files from the normal Windows Downloads folder.

Only secure-origin permissions on the explicit askable list reach the user.
Other permissions are denied, including display capture and direct device
access (HID, serial, USB, and Bluetooth). Certificate errors, HTTP-auth prompts,
unsafe protocols, insecure nested navigation, and unexpected webviews are
blocked. An approval can be remembered only for the current app session.

## Workflow recording

Workflow recording is Windows-only and opt-in. Before **Record**, the native
`uiohook-napi` module is not loaded and no global keyboard or mouse hook is
running. Starting creates one local capture session and registers
`Ctrl+Shift+F12` as a global panic stop when the operating system permits it.
The on-screen **Stop**, panic stop, two-hour duration limit, and app shutdown
all stop the hook and unregister the shortcut. A conspicuous REC bar remains
visible while recording. Frame/storage caps skip further screenshots and warn
the user while the low-cost event timeline continues until recording stops.

The recorder aligns wall-clock and monotonic timestamps for global mouse
down/up/click/move events, key down/up codes and modifiers, best-effort active
application/window/UI-element context, and active Tethoq browser tab metadata.
Mouse movement is sampled every 24 ms; drag screenshots are requested every
180 ms; keyboard-triggered screenshots are limited to one every 900 ms, and
the more expensive foreground/UI Automation context lookup is sampled at most
once every 750 ms while typing. Each
captured frame saves the full display and a 640x480 crop around the cursor.
Completed drags also receive bounded summary crops covering their start, path,
and endpoint. Defaults cap a recording at two hours, 2,000 frames, 2 GiB, and
two pending capture jobs so overloaded machines drop frames instead of growing
an unbounded capture queue. Foreground-context work and in-memory drag samples
are also bounded, simultaneous UI Automation requests share one lookup, and a
short same-cursor cache avoids duplicate helper processes without replacing
the exact context captured at meaningful input points. Cross-display drags use
virtual-screen coordinates, including monitors positioned left of the primary.
If completed image writes cross the soft byte budget, newest screenshot assets
are pruned before the workflow is staged; the chronological event record stays
intact and records missing captures explicitly. Live recording counters are
also capped at ten updates per second, independently of the durable event
timeline, so fast mouse movement does not force a renderer update per hook
event.

Local storage is `%USERPROFILE%\Documents\Tethoq\Workflows`. Each workflow is
an inspectable folder:

```text
workflow.json             Versioned manifest, limits, displays, summary, privacy
events.ndjson             Chronological input/context/frame references
screens/full/*.jpg         Full-display captures
screens/cursor/*.jpg       Cursor-centred close-ups
screens/drag-summary/*.jpg Drag path overview crops
```

After **Stop**, the folder stays staged until the user supplies a name and
saves it, keeps it staged, or discards it. Saved workflows can be opened,
deleted, and attached by reference in a coding chat. The chat receives the
local manifest and event-file paths plus a short summary; recording folders are
never uploaded implicitly.

Recording can expose sensitive screen pixels, key identities, file names,
window titles, browser URLs, and accessible-control labels. It records hardware
key codes/modifiers rather than reconstructed text or clipboard contents, and
redacts detected password-field labels, but password detection is only best
effort. Cross-application drags do not always reveal the exact carried file or
folder. Secure, elevated, DRM-protected, and hardware-accelerated windows may
be blank or incomplete. Users should inspect the local folder before sharing
any part of it.

## Instant sessions (experimental)

Instant sessions are a lightweight, conversational alternative to workflow
recording. They are available only while **Settings > Experimental features >
Enable experimental features** is on; with the toggle off every entry point is
hidden and the main-process gate rejects any session request, so no
microphone or screen permission is ever requested.

Press **Start instant session** in the task composer and speak naturally. Each
utterance is voice-segmented in the renderer, transcribed through the
configured dictation source, and sent to the selected task together with
synchronized evidence: wall-clock utterance timestamps, the pointer path with
absolute, display-relative, and normalized coordinates, the hovered UI
element/app/window/browser context, one downscaled full-display frame, and a
cursor-centred crop captured once per utterance at its end. When the task's
model can receive images, the frames are attached to the message; when it
cannot, the user-selected visual-support ("eyes") model describes the
cursor-centred frame and that compact description is attached instead. Stop
ends microphone, pointer sampling, and capture immediately; nothing is written
to disk, and utterance audio attachments are consumed by the transcriber, so
no raw recording is retained after the session.

## Add a connector

Connector authors do not need to depend on the desktop implementation. The public SDK lives at [`packages/connector_sdk`](../../packages/connector_sdk) and contains the versioned manifest/schema, TypeScript server and process client, an echo connector, tests, and protocol documentation.

Install a connector by putting one bundle directory under the connectors path shown in **Settings > External connectors**. Each bundle must contain `tethoq.connector.json`. Restart Tethoq, review the connector's exact fingerprint, execution plan, and declared permissions, then explicitly enable it. Approval takes effect after another restart. Revocation immediately removes the connector from the authorized provider set and stops its process; restart afterward to complete cleanup and rediscovery. Any content, manifest, or execution-plan change invalidates approval and requires review again. An approved connector's live `provider.models.list` result feeds both model pickers automatically.

Packaged releases also include an author kit under the installed app's
`resources\connector-sdk` directory: the compiled SDK, declarations, JSON
Schema, MIT license, documentation, and Echo connector example. Connector
authors can use that kit or the independently published npm package without
access to the desktop renderer source.

The desktop never scans npm, repositories, or arbitrary folders for extensions. Manifests are explicitly discovered only in that connector directory. Connector processes are isolated from Electron and receive a filtered environment, bounded JSONL messages, and time-limited RPC calls. They receive no Tethoq private identity or secrets; only host runtime values and environment names explicitly declared in the manifest are passed. Permission declarations are informational rather than an operating-system sandbox. Connectors still execute with the signed-in operating-system user's filesystem and network rights, so install only connectors you trust.

Community connectors are independent third-party software. Tethoq does not review, endorse, certify, support, or claim affiliation with them. Connector authors and users must ensure each provider integration is authorized and complies with that provider's terms and applicable policies. Provider credentials should remain in the provider's local tool or connector and must not be embedded in manifests or stored by Tethoq.

This boundary keeps the MIT-licensed `packages/connector_sdk` independently
publishable even though the complete Desktop source is available in this
monorepo. A connector's manifest, declared capabilities/permissions, and live
model list are validated before the separate process is surfaced in provider
and model pickers. The SDK does not grant runtime access to Electron, private
Bridge identity, or GUI internals.

## Run locally

From this folder:

```powershell
npm install
npm run dev
```

OpenCode is supervised at `http://127.0.0.1:4096/`. If an existing healthy OpenCode server is already there, Tethoq uses it and leaves it running. Otherwise Tethoq launches:

```text
opencode serve --hostname 127.0.0.1 --port 4096
```

Codex and Grok use their installed local protocol processes. Optional advanced overrides are available through `TETHOQ_CODEX_COMMAND`, `TETHOQ_CODEX_ARGS`, `TETHOQ_GROK_COMMAND`, `TETHOQ_GROK_ARGS`, `TETHOQ_OPENCODE_URL`, `TETHOQ_OPENCODE_COMMAND`, and `TETHOQ_PROJECT_DIRECTORY`. Argument overrides are JSON string arrays. Legacy `UAR_*` names remain accepted as fallbacks.

Each built-in adapter is shared across all of its sessions: one Codex app-server
transport, one Grok ACP transport, and one OpenCode HTTP/SSE client. Each
approved external connector likewise receives one long-lived process rather
than one process per task. Compatible sessions receive Tethoq's authenticated
local browser and mesh tools only when their protocol supports them; visual-only
helper sessions start without recursive tools. Provider and
connector process trees are terminated at shutdown/revocation on Windows, and
verified connector runtime snapshots left by a crash are reclaimed after 24
hours.

## Build and verify

```powershell
npm run verify
```

This runs the TypeScript check, focused Node tests, and the production Electron build. To create the Windows NSIS installer:

```powershell
npm run pack:win
```

The installer is written to `release`. For deterministic renderer screenshots, first build the app and then run:

```powershell
npm run qa:visual
```

Screenshots and layout metadata are written to `qa-artifacts`. The visual fixture uses the browser-preview dataset and does not start providers or touch live sessions.

To write the same artifacts somewhere else, run the built-in capture directly with an absolute output path:

```powershell
electron scripts/visual-qa.cjs "C:\path\to\artifacts"
```

`npm run pack:win` also runs the root Bridge build and
`scripts\release\build-bridge-portable.ps1`. The NSIS installer embeds
the same compact Tethoq Bridge companion and engine offered by the standalone
Bridge installer. Desktop installation provides a separate **Tethoq Bridge**
shortcut; the Bridge remains alive in its tray when Desktop closes, and
Desktop never owns or kills an already running Bridge. Build the Bridge-only
download directly from the repository root with:

```powershell
npm run release:bridge:win
```

Its NSIS installer and metadata are written to `artifacts\releases\bridge`.
The installer includes a pinned Windows x64 Node.js runtime plus the compact
tray companion, so users do not need to install Node separately. The adjacent
engine ZIP is for advanced diagnostics and does not contain the tray UI.
Publish the Desktop and Bridge installers on an artifact host and point the
website at their direct HTTPS URLs; neither large binary is copied into the web
app. Desktop packaging also writes `release\release-manifest.json` and
`release\SHA256SUMS.txt` beside the installer for the website checksum link.

## Desktop behavior

- Closing the window hides it to the tray by default so active work and
  notifications continue. **Settings > Desktop behavior > Close** can change the
  close button to quit Tethoq instead.
- **Settings > Desktop behavior > Startup** registers Tethoq as a Windows login
  item, either opening its window or starting straight to the tray (`--hidden`).
  Only a packaged build registers the login item; a development run stores the
  preference without writing to the Run key.
- **Settings > Desktop behavior > Alerts** chooses which unfocused events raise a
  Windows notification: everything, only the events that need a decision
  (approvals, questions, failures), or nothing.
- Task names, pins, and archived state are stored locally per task in the desktop
  preferences file. A local name is display-only and never rewrites the
  provider's own session title.
- Desktop does not silently auto-start the separately bundled Bridge in this
  release. Until Desktop's connector/runtime state is migrated to one local
  Bridge client, explicit Bridge startup avoids duplicate provider owners.
- An active Bridge can handle signed `desktop.status` and `desktop.wake`
  requests from a paired phone. Wake uses only its fixed installed Desktop path
  and an opaque, loopback-only readiness check.
- A single-instance lock prevents two desktop bridge owners from competing for the same local state and provider processes.
- Window size and position are restored across launches.
- Active chat events are checked at 100 ms while the window is visible and at
  1 second while it is hidden, returning to the faster cadence immediately on
  show.
- Provider connectivity, working sessions, approvals, requested input, completion, and failures surface in the task list and, subject to the Alerts setting, Windows notifications.
- Images are selected through a native dialog and checked for type, count, and size before crossing the IPC boundary.

## Security boundary

Provider processes, authentication, private host identity, pairing state, persistence, filesystem access, and the request router stay in Electron's main process. The renderer receives a frozen, explicitly allowlisted API through an isolated preload. It never receives raw Node, Electron, IPC, provider credentials, private keys, pairing secrets, or unrestricted bridge access.

The renderer runs with Node integration disabled, context isolation and Chromium sandboxing enabled, navigation and new windows blocked, and a restrictive Content Security Policy. Permissions are denied except an audio-only microphone request from the trusted main renderer for explicit dictation. Every IPC call verifies the sender and main frame. Bridge operation names are allowlisted, and both direct provider targets and delegation targets are constrained to the built-in provider IDs plus currently approved runtime connector IDs.

The internal Electron renderer talks directly to the locally owned bridge through main-process IPC. Ed25519 pairing and signed request envelopes remain required for external WebSocket clients; they are deliberately not exposed through this desktop renderer.
