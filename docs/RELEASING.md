# Releasing NoteTOO

NoteTOO releases are published on the public, releases-only repository
[`Gamerhoobh1290/notetoo-releases`](https://github.com/Gamerhoobh1290/notetoo-releases). The source stays in this
private repo. **NoteTOO Updater** installs a release only if it was signed with the release key.

## What a release contains

| Asset | What it is |
|---|---|
| `NoteTOO-Setup-<version>.exe` | The normal per-user NSIS installer (`npm run dist:win`) |
| `latest.json` | Version, release notes, installer URL, size and SHA-256 |
| `latest.json.sig` | Ed25519 signature over the exact bytes of `latest.json` |
| `NoteTOO-Updater-Setup-<version>.exe` | The updater's installer (attached when it was built) |

The updater reads `https://github.com/Gamerhoobh1290/notetoo-releases/releases/latest/download/latest.json`
(and `.sig`), so the release marked **Latest** on GitHub is what every user is offered. It checks, in order:
the signature (against `updater/releaseKey.mts`), the manifest fields, that the version is newer than the installed
one, then the download's size and SHA-256. Anything that fails is refused and deleted.

## One-time setup

```bash
node scripts/release/keygen.mjs
```

Creates the signing key at `%USERPROFILE%\.notetoo-release\release-key.pem` and writes the public half into
`updater/releaseKey.mts` (commit that file). **Back up the private key** somewhere safe and never commit it: if it
is lost, every installed updater refuses new releases until users install a new updater by hand. To sign from
another PC, set `NOTETOO_RELEASE_KEY` to the key file's path. `keygen` refuses to replace an existing key.

You also need the GitHub CLI logged in with write access to the releases repo (`gh auth status`).

## Every release

1. Bump `"version"` in `package.json` (x.y.z only, higher than the last release).
2. Write `release-notes/<version>.md` (Markdown, shown in the updater's "What's new").
3. Build: `npm test`, then `npm run dist:win` → `release/NoteTOO-Setup-<version>.exe`.
4. Sign: `npm run release:sign` → `release/latest.json` and `release/latest.json.sig`. It verifies its own output with
   the updater's code, so a key mismatch fails here and not on users' PCs.
5. Optional, when the updater changed: bump `extraMetadata.version` in `updater/electron-builder.json`, then
   `npm run dist:updater` → `release/updater/NoteTOO-Updater-Setup-<version>.exe`.
6. Publish: `npm run release:publish`. It re-verifies the signature and the installer's hash, then runs
   `gh release create v<version> … --latest` with the assets above.
7. Commit and tag: `git tag v<version>`.

To withdraw a broken release, mark the previous one as Latest on GitHub (or delete the bad one): the updater only
ever offers a version newer than the one installed, so nobody is moved backwards.

## Testing an update before publishing

The updater accepts a test feed: `NOTETOO_UPDATE_FEED=<url of a latest.json>`. Serve `release/` locally, e.g.

```bash
npx http-server release -p 8765
```

and start the updater with `NOTETOO_UPDATE_FEED=http://127.0.0.1:8765/latest.json`. The installer URL inside
`latest.json` still points at GitHub, so for a fully local test, sign a manifest whose `url` points at the local
server. A test feed must still be signed with the release key.

## What an update keeps

The installer replaces only the program folder. Notes, annotations and the scratchpad live in the user's school
folder; window, recent folders, theme and AI settings in `%APPDATA%\NoteTOO`. Neither is touched
(`deleteAppDataOnUninstall: false`). Before installing, the updater asks NoteTOO to close the way its own close button
does, so pending edits are saved first; it never forces NoteTOO to quit.
