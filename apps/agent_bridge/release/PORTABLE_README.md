# Tethoq Bridge for Windows

Tethoq Bridge connects the coding-agent harnesses already installed on this
computer to approved Tethoq clients. It supports Codex, OpenCode, Grok Build,
Pi, OMP, Qwen Code, Goose, Kimi, Hermes Agent, Cline, GitHub Copilot CLI, and
the Direct API provider for user-supplied model keys. Claude is intentionally
not included in this release.

## Start the diagnostic engine

1. Extract the entire ZIP to a folder you control.
2. Run `Start Tethoq Bridge.cmd` from PowerShell or Command Prompt.
3. Stop it with `Ctrl+C` in that terminal.

To pair a phone without configuring a relay first, double-click
`Pair a phone.cmd`. A temporary encrypted endpoint and a local pairing page are
created only for that pairing session.

This engine ZIP is intended for diagnostics and advanced configuration. It does
not contain the compact tray companion; use the standalone Tethoq Bridge
installer for the normal tray-first experience.

```powershell
& '.\Start Tethoq Bridge.cmd' --help
& '.\Start Tethoq Bridge.cmd' --host 127.0.0.1 --port 8765
```

## Runtime and local data

- The ZIP includes a pinned Windows x64 Node.js runtime. Node.js does not need
  to be installed separately.
- New installations create Bridge identity and settings under
  `%USERPROFILE%\.tethoq`. If `%USERPROFILE%\.universal-agent-remote` already
  contains Bridge state, the Bridge reuses that legacy folder so existing
  identity and pairings survive an update.
- Repository contents and provider credentials remain on this computer. The
  bridge never asks you to copy a harness login. A Direct API key is stored
  only when you explicitly configure that endpoint; it is encrypted in local
  state and is never sent to a paired client or relay.
- The bridge binds to `127.0.0.1` by default. Do not expose its local socket to
  an untrusted network.

This is preview software. Verify the archive SHA-256 against the published
`SHA256SUMS.txt` before opening it.

## Stop and remove

Stop the terminal process, then delete the extracted folder to remove this
diagnostic engine bundle. Local identity and settings remain in the selected
data folder so an update can preserve pairing; delete that folder separately
only if you also want to forget this bridge identity.
