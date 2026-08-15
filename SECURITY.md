# Security policy

## Development-preview status

Tethoq is currently a development preview. Do not expose its local Bridge
directly to the public internet, deploy the included relay as an unreviewed
multi-tenant service, or rely on it as a security boundary for untrusted users.
The detailed threat model and hardening checklist are in
[docs/SECURITY.md](docs/SECURITY.md).

## Why the project is sensitive

A paired client may be able to read agent transcripts, send instructions and
attachments, approve or reject requested actions, interrupt work, and interact
with repositories available to local coding tools. A compromised host identity,
device credential, relay token, pairing code, connector, or host account can
therefore cause source disclosure or actions with the host user's permissions.

## Safe development defaults

- Keep `TETHOQ_BRIDGE_HOST=127.0.0.1` (legacy `UAR_BRIDGE_HOST` is also
  recognized).
- Do not set `TETHOQ_ALLOW_UNSIGNED_LOCAL=1` outside an isolated test setup.
- Use `wss://` and a unique random relay token of at least 32 characters for
  any non-local relay.
- Never commit `.env` files, signing material, provider databases, runtime
  state, access tokens, private keys, pairing payloads, transcripts, or logs.
- Treat a displayed pairing QR as a temporary credential.
- Pair only devices you control and revoke credentials for devices that are
  lost, sold, or no longer trusted.
- Run Tethoq as an ordinary user, not Administrator or root.
- Install only connector bundles you trust. Connector permission declarations
  are informative and do not create an operating-system sandbox.
- Install provider CLIs only from their official distribution channels. A
  detected harness runs as the current host user and retains the authority of
  its own tools, extensions, credentials, and configuration.

## Browser and visual-support boundary

Desktop browser tools can navigate, inspect, click, type, scroll, and capture
pages in Tethoq's persistent browser partition. Semantic references and the ban
on arbitrary page scripts/selectors reduce the available surface; they do not
make a signed-in browser session a sandbox. A prompt-injected page or model can
still attempt consequential actions through ordinary controls. Keep provider
approval prompts enabled, review target origins and form contents, and do not
use the agent browser for accounts whose authority exceeds the task.

Browser tabs and semantic references are scoped to the parent agent session.
Inspection text and screenshots may contain passwords, tokens, private source,
personal data, or other secrets. A `browser_capture` call sends the screenshot
to the visual-support model selected by the user. That model may be operated by
a different provider from the primary session, so its terms, retention, and
data controls apply. With no configured helper, Tethoq reports visual support
as unavailable.

Desktop installs only Tethoq-owned OpenCode/Pi tool files for this feature.
The standalone Bridge requires `TETHOQ_ALLOW_PROVIDER_CONFIG_MUTATION=1` before
changing Codex/OpenCode tool configuration. ACP tools are passed in the
session, and OMP tools use its host-tool RPC surface. None of these mechanisms
creates an operating-system sandbox around the provider process.

The Codex rollout/desktop-queue and OpenCode SQLite activity integrations are
experimental host-state readers. See the root README and detailed security
documentation before enabling or distributing them.

## Reporting a vulnerability

Do not disclose exploitable details in a public issue. Use the repository
host's private vulnerability-reporting flow when it is enabled and include the
affected version, operating system, reproduction steps, impact, and any
suggested mitigation.

No public security-support window or production SLA is promised for this
preview.
