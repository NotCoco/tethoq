# Echo connector

This deliberately small connector proves that a third party can add models to
the picker without importing or receiving the desktop GUI source.

When developing from this repository, build the package and example:

```powershell
npm run build:example
node examples/echo/connector.js
```

The published package already contains `examples/echo/connector.js`; run it
from an installed `@tethoq/connector-sdk` package so its self-reference
resolves normally.

The process waits for JSON-RPC 2.0 JSONL messages on stdin. In a real connector,
replace the in-memory handlers with calls to your model CLI, daemon, or API.
