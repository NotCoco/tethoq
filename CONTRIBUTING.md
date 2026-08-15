# Contributing

Thank you for helping improve Tethoq.

## Before opening a change

1. Keep provider-specific behavior in its adapter and preserve the normalized,
   provider-neutral boundary.
2. Preserve least-privilege defaults: loopback listeners, authenticated
   actions, bounded reads, explicit connector approval, and no secret logging.
3. Use documented provider interfaces where available. Clearly identify
   experimental dependencies on undocumented local files, databases, IPC
   endpoints, or protocols.
4. Keep changes focused and add the smallest relevant tests.
5. Never include credentials, signing keys, provider databases, runtime state,
   user transcripts, pairing payloads, or private user data in an issue,
   fixture, screenshot, test output, or pull request.

## License boundary

Except where a third-party file states otherwise, contributions to this
monorepo are made under the MIT License. `packages/connector_sdk` keeps a
nested copy of the same license for independent distribution. Third-party
assets and marks are not relicensed by the source-code license.

## Local checks

Use Node.js 22.13.0 or newer. For the root Node workspaces, run:

```text
npm ci
npm run verify
```

Run the smallest relevant package, Desktop, web, or Flutter check for any area
you change. Real-provider integration tests must remain opt-in, must not mutate
user data unexpectedly, and must document their required environment variables.

## Pull requests

Describe the user-visible change, trust-boundary impact, tests run, and any
remaining limitations. Keep unrelated formatting or refactoring out of the
same change.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a
public issue.
