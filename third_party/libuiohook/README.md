# libuiohook source and relinking information

Tethoq Desktop depends on `uiohook-napi` 1.5.5 for its optional Windows
workflow recorder. The npm package contains an MIT-licensed Node wrapper and a
statically built copy of `libuiohook`, whose source headers state
LGPL-3.0-or-later.

The exact wrapper package and bundled library source can be obtained with:

```text
npm pack uiohook-napi@1.5.5
```

After extracting the archive, the library source is under
`package/libuiohook/src` and `package/libuiohook/include`; wrapper and native
build inputs are under `package/src` and `package/binding.gyp`. The same source
is installed under `apps/desktop_harness/node_modules/uiohook-napi` after the
repository lockfile is installed.

To test a modified compatible library, replace the installed `libuiohook`
source, rebuild `uiohook-napi` from source with its documented Node-gyp build,
then run the Desktop verification and packaging commands in
`apps/desktop_harness/README.md`. Tethoq places no additional restriction on
reverse engineering or relinking for debugging modifications to this library.

The full LGPLv3 and incorporated GPLv3 texts are in this directory. The
wrapper's MIT text is in `../uiohook-napi/LICENSE`. A binary distributor must
ensure that the exact corresponding source remains available alongside the
binary for the period and in the form required by the licenses.
