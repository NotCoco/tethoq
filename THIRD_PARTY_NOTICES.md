# Third-party notices and asset provenance

Third-party open-source dependencies retain their own copyright notices and
licenses. The applicable dependency sets are recorded in the npm lockfiles and
Flutter lockfile; packaged distributions must continue to include the licenses
required by those dependencies.

## Provider identities

Tethoq names compatible third-party tools only to identify interoperability.
The repository and official builds do not bundle their logos. Built-in
providers use original, neutral Tethoq glyphs instead, avoiding any suggestion
of sponsorship, endorsement, partnership, or affiliation. User-installed
connectors may supply a local data-URL icon; its author and user remain
responsible for the right to use and distribute that icon.

The original glyphs are not traced, recolored, simplified, or otherwise
derived from provider logos. Text labels use the provider names only so users
can identify which separately installed executable or endpoint Tethoq will
open.

## Compatible harness software

Tethoq's built-in adapters invoke separately installed tools through their
documented protocols. Tethoq does not redistribute the provider executables or
copy their implementation code. The upstream project licenses recorded during
the 2026-08-14 compatibility review are:

| Compatible tool | Upstream status | Source/license reference |
|---|---|---|
| OpenAI Codex | Apache-2.0 | https://github.com/openai/codex |
| OpenCode | MIT | https://github.com/anomalyco/opencode |
| Grok Build | Apache-2.0 | https://github.com/xai-org/grok-build |
| Pi | MIT | https://github.com/earendil-works/pi |
| OMP (Oh My Pi) | MIT | https://github.com/can1357/oh-my-pi |
| Qwen Code | Apache-2.0 | https://github.com/QwenLM/qwen-code |
| goose | Apache-2.0 | https://github.com/aaif-goose/goose |
| Kimi Code CLI | MIT | https://github.com/MoonshotAI/kimi-code |
| Hermes Agent | MIT | https://github.com/NousResearch/hermes-agent |
| Cline | Apache-2.0 | https://github.com/cline/cline |
| GitHub Copilot CLI | GitHub Copilot CLI License; service terms apply; ACP server is public preview | https://github.com/github/copilot-cli/blob/main/LICENSE.md |

These references do not replace the license and service terms that accompany
the user's installed version. In particular, open-source permission for a CLI
does not grant trademark rights or alter the terms of an optional hosted model
service. GitHub Copilot authentication, eligibility, billing, and service use
remain governed by GitHub.

## Flutter-generated scaffolding

Parts of `apps/remote_client/android` and `apps/remote_client/windows` were
generated from Flutter project templates. Those template-derived portions
retain the Flutter Authors' BSD 3-Clause terms in
`apps/remote_client/LICENSE.flutter`; the repository MIT License covers
Tethoq-authored additions rather than replacing those terms.

## Desktop input-hook dependency

The optional Windows workflow recorder uses `uiohook-napi` 1.5.5. Its Node
wrapper is MIT licensed; its bundled `libuiohook` native library is licensed
under LGPL-3.0-or-later. The applicable texts are preserved under
`third_party/uiohook-napi` and `third_party/libuiohook`. Desktop distributors
must also preserve the library's corresponding-source, relinking, installation,
and reverse-engineering-for-debugging rights described in those licenses. See
`third_party/libuiohook/README.md` for the reproducible source and rebuild path.

## PDF text extraction

The OpenCode PDF fallback uses `unpdf` 1.8.1, copyright Johann Schopplich and
contributors, under the MIT License (https://github.com/unjs/unpdf). Its
serverless PDF parser includes code derived from Mozilla PDF.js under the
Apache License 2.0 (https://github.com/mozilla/pdf.js). These components are
used only to extract bounded text locally when a selected model does not
advertise native PDF input.

## Direct API services

The built-in Direct API entry is Tethoq-authored client code, not redistributed
provider software. It can make user-authorized HTTPS requests to OpenAI,
Vercel AI Gateway, Z.ai, CrofAI, Google Gemini, OpenRouter, xAI, DeepSeek, Groq, Mistral,
Together AI, Fireworks AI, Cerebras, and Perplexity, or to a user-configured
HTTPS endpoint with a compatible OpenAI request shape. Each service remains
separately operated and governed by its own current terms, privacy practices,
model licenses, account eligibility, pricing, and billing. Tethoq does not
grant access, resell provider credit, or guarantee every model or
provider-specific extension.

No provider logo is bundled for these entries. The provider name is a textual
compatibility label beside original Tethoq artwork. API keys are supplied by
the user and retained only on the host; provider balances remain
provider-owned. A Tethoq local spend budget is only an application-side cap,
not stored value or an authoritative statement of account credit.

## Tethoq integration assets

The OpenCode tool module, Pi extension, ACP MCP configuration, OMP host-tool
definitions, browser schemas, visual-support prompts, and compatibility glyphs
in this repository are Tethoq-authored integration assets covered by this
repository's license. They are not upstream provider plugins, logos, or
endorsements.
