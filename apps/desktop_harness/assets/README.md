# Desktop assets

`tethoq-icon.png` is the canonical desktop source mark. The checked-in Windows
icons and NSIS artwork under `build/` are derived from it by
`npm run build:brand-assets`; the script produces deterministic output and
verifies the source dimensions before writing anything.

Provider compatibility rows use original Tethoq glyphs rendered by the app.
No provider logos are bundled.
