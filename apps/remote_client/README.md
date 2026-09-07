# Remote Client

Flutter client foundation for iOS, Android, desktop, and later web support.

Implemented surfaces:

- secure host/device credential storage through `flutter_secure_storage`;
- Ed25519 pairing credentials and signed, expiring, replay-resistant bridge actions;
- direct WebSocket and outbound-relay transport modes;
- reconnect with exponential backoff, request-ID retry, event deduplication, and composer draft preservation;
- sessions, handoff and branch transfers, searchable model selection, wallet
  status, image previews, approvals, requested input, interruption, refresh,
  host, and provider screens.

The checked-in Flutter client includes Android and Windows launchers. Verify it
with:

```bash
flutter pub get
flutter analyze
flutter test
```

Review the real application UI without pairing a bridge by launching its
in-memory sample data source. The normal launch path remains bridge-backed.

```bash
flutter run -d windows -- --demo --phone-preview
```

`--demo` swaps only the data/transport boundary; it uses the same screens and
interactions as production. `--phone-preview` only changes the initial Windows
window size and has no effect on mobile builds.

Android must target API 23 or newer because `flutter_secure_storage` 10 uses its current secure cipher implementation. Validate Keychain/Keystore behavior on physical devices before production use.

The current WebSocket transport uses `dart:io`; web is a future target and is not included in the launcher-generation command.

## Install the Android preview

Download the APK from [GitHub Releases](https://github.com/NotCoco/tethoq/releases)
and open it on your Android device. Install the matching Windows Desktop
release on your computer, then launch **Tethoq Bridge** from the Start menu.
The Desktop installer already includes Bridge and its runtimes.

Use Bridge's **Pair phone** control and scan its QR code with the mobile app.
Keep Bridge running in its tray to keep the phone connected. The normal phone
pairing flow provides a secure tunnel, so the phone does not need to share the
computer's local network. Running the Desktop workspace is optional once
Bridge is running.

## Build a signed Android release

Use a persistent Android release keystore and a `key.properties` file stored
outside the repository. The properties are `storeFile`, `storePassword`,
`keyAlias`, and `keyPassword`; a relative `storeFile` resolves beside that
properties file. Reuse the same key for future APK updates and increase the
build number after `+` in `pubspec.yaml` for every release.

From the repository root on Windows, with Flutter and the Android SDK installed:

```powershell
$env:TETHOQ_ANDROID_KEY_PROPERTIES = 'C:\release-signing\android\key.properties'
npm run release:android
```

The command builds a release APK, verifies its signature, package identity,
version, and non-debuggable status, and writes the APK, source/signing metadata,
and SHA-256 checksum to `artifacts/releases/android`. Publish those files beside
the matching Desktop installer. Signing credentials are never included in the
release assets.

Tethoq-authored code is covered by the repository MIT License. Flutter-derived
scaffolding retains the BSD 3-Clause terms in `LICENSE.flutter`.
