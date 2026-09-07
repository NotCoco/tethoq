# Desktop updates

Installed Windows copies check the public `NotCoco/tethoq` GitHub Releases feed
30 seconds after launch and every four hours. Settings also offers **Check for
updates**. When a release is available, the sidebar points to it. Users download
inside Tethoq and choose **Restart to update** when their tasks are finished.
Downloading never quits the app; closing the app does not silently install an
update. Running tasks and recordings prevent an update restart.

The current 0.x builds receive published preview releases. Stable 1.x builds
receive stable releases. Draft releases are not offered, and downgrades are
disabled. Electron Updater verifies the download checksum and retains its
standard Windows publisher verification when a signing certificate is used.
The update feed is fixed in `electron-builder.yml`; it is not inferred from a
developer's Git remote. No GitHub token is included in installed apps.

## Sending a release

1. Increase the version in `apps/desktop_harness/package.json` and its lockfile
   (`npm version <version> --no-git-tag-version` from that directory). Merge the
   version and intended changes to main. Use a new version for every release.
2. Run **Prepare Desktop update** from the public repository's Actions page on
   main. It verifies and builds the installer, checks the update metadata against
   the installer, and creates a draft GitHub release. A draft can be reviewed and
   combined with other release assets before publication.
3. Review the draft and choose **Publish release**. Installed copies will find
   it on their next check; users can also check immediately in Settings.

For a local release build, run `npm run pack:win` followed by
`npm run release:draft` in `apps/desktop_harness`. Install the companion
dependencies first (`npm ci` in `apps/desktop_companion`). The build must come
from a clean, committed revision available in the public repository. The draft
command never replaces an existing release. Keep the generated installer,
`.exe.blockmap`, and `latest.yml` together; the metadata command rejects mixed
versions or mismatched checksums.

## First upgrade

Installers shipped before this updater was added cannot acquire it remotely.
Those users need one normal upgrade to an installer containing the updater;
subsequent releases can be downloaded and applied inside Tethoq. Existing
conversations, settings, and provider installations are retained. Development
and manually copied builds without a packaged update feed show updates as
unavailable.
