# Viking Factory Manager

A Rust management CLI and native macOS menu bar companion for installing and operating compatible factory bundles. The companion calls the same CLI used in automation. It is intended for Apple silicon Macs running macOS 13 or newer.

The v0.2.0 preview has passed lifecycle tests, a disposable real Codex mission and a live GitHub download and update acceptance. See [acceptance evidence](docs/acceptance.md) for the exact scope. The companion is Developer ID signed and notarized with a pinned update public key. Download the setup archive from the [v0.2.0 release](https://github.com/ChaosDeSelva/Viking-Software-Factory/releases/tag/v0.2.0). Existing v0.1.0 source releases do not contain installable runtime assets.

## Local development

```sh
cargo test --locked
bash scripts/build-app.sh
open 'dist/Viking Factory.app'
```

The app uses a V menu bar item. Its window provides bundle installation, health checks, service controls, private access codes, update checks, rollback, local logs and metadata diagnostics. Quitting the companion leaves managed services running. Use Stop services to stop them. Launch at login is optional.

The CLI is at `target/release/viking`, and is also embedded in the app at `Contents/Resources/viking`.

## Installation and first session

A managed bundle contains Node and npm, the built factory services and their production dependencies. Optional packages contain Skidbladnir, Hulder and Bifrost. Users of a prepared bundle do not need Rust, Xcode, npm or pnpm to build the factory. Git and authenticated agent tools are separate prerequisites; use Health check and Agent sign in for guidance. Cloud accounts are optional and installation does not create cloud resources.

1. Open the companion and choose optional components.
2. Select Install bundle. For the public setup archive, select `factory-manifest.json` inside the extracted `bundle` directory. Keep its package archives alongside it.
3. Run Health check. Install Git and the official Codex and Claude Code tools if needed, then complete their official sign in flows.
4. Start factory and open Heimdall. Access codes displays the private credentials for the current local session.
5. Start workers separately if you selected Skidbladnir. This starts its simulator, not an AWS fleet.

```sh
viking install /path/to/factory-manifest.json skidbladnir hulder bifrost
viking doctor
viking start
viking open heimdall
viking access
viking stop
```

Local manifests are a deliberate trust boundary: installing one executes its packaged software during preflight. Only select a bundle you built or trust. Remote updates require a verified Ed25519 manifest signature in addition to package checksums.

## Private state and service ownership

Default root: `~/Library/Application Support/Viking Factory`. Override it with `VIKING_HOME` or `--home /absolute/path` for isolated testing. The manager creates private state directories and uses an exclusive operation lock.

Each installation gets distinct launchd labels derived from its root. Ports are checked before startup, and unmanaged services are never stopped. Default ports are 7700, 4310, 4320 and 4380. To coexist with another local factory, configure four unused ports before starting:

```sh
viking config ports 47700 44310 44320 44380
viking config path "$PATH"
```

Launchd owns the background processes, so closing a terminal does not terminate them. Startup requires service health responses. Shutdown waits for managed ports to close before update data backups are taken. Failed startup is reported with local logs; the manager does not repeatedly relaunch a broken service.

Project state lives in `data`, installed code in `releases`, recovery copies in `backups` and logs in `logs`. Developer checkouts are never modified by installation. `uninstall --confirm` removes managed release files but preserves data, backups and configuration. External repositories and accounts are never removed.

## Updates and recovery

This installs prebuilt archives. It does not clone repositories, run git pull or compile every project on the operator’s Mac. Source development remains a separate workflow. Projects do not each need a DMG; one companion app manages the collection, while Hulder can also be distributed independently.

The companion asks the manager to check periodically. Successful cached results suppress checks for 24 hours; Check updates forces a fresh request. Checks happen only while the companion is running and resume after wake. All eight project release feeds are displayed; only a compatible factory bundle is installable. Individual component releases do not silently update the collection. A bundle can include an updated companion. After installing it, choose Open updated companion from the V menu. This opens the new app and exits the old companion.

Use `channel stable` or `channel preview`. Update selection compares semantic versions and excludes drafts. Stable excludes prereleases. Network failure is reported instead of being interpreted as an available update.

```sh
viking update check --force
viking update apply
viking rollback
viking recover
```

Application checksums and the manifest signature are verified before activation. Archives are bounded, traversal is rejected, and internal links are resolved inside the installation. A staging failure leaves the current version intact. Active or paused missions prevent stopping or updating. Unknown execution state fails closed.

Data is backed up while the managed services are stopped. Rollback restores both the prior application pointer and its data backup, retaining the replaced data separately. Services remain stopped after a manual rollback. Interrupted activation is recorded in `transaction.json`; run Recover update before further installation.

Data schema 1 is the only supported schema. Releases that change it are refused until an explicit migration and recovery strategy is implemented. A new schema is never treated as safe just because the application version increased.

## Package a release

Run on the target Apple silicon Mac from a built factory checkout:

```sh
python3 manager/scripts/package-runtime.py \
  --source . --output /tmp/viking-bundle --version 0.2.0 \
  --bifrost /path/to/built/bifrost --hulder /path/to/Hulder.app
```

Use `--skip-build` only for an already verified local build. The packager uses production dependency deployments, preserves internal links, carries the Node license and retains project notices. Optional IDE binaries must be built and checked separately. Use `--companion` to include a separately built companion app in coordinated updates. Do not bundle an arbitrary personal IDE build for public release.

To make an app with a local bundle included:

```sh
VIKING_BUNDLE_DIR=/tmp/viking-bundle bash manager/scripts/build-app.sh
```

Without `VIKING_SIGN_IDENTITY` this creates an ad hoc local build, not a public distribution. The manager and companion require their own acceptance checks in addition to factory tests.

## Release signing

Create and retain a signing key outside every source repository and release directory:

```sh
cargo run --bin viking-release -- keygen /private/key/location/viking-update.pk8
cargo run --bin viking-release -- sign /private/key/location/viking-update.pk8 /tmp/viking-bundle/factory-manifest.json
```

The first command prints only the public key. Build the trusted public key into the manager with `VIKING_UPDATE_PUBLIC_KEY`. The build script reads the committed `update-public-key.txt` unless an explicit build variable overrides it. This file contains only the public key. Existing installations can explicitly configure their trusted key in private `config.json`; it is never learned automatically from the downloaded manifest.

Use a Developer ID identity for public Mac builds and an existing notarytool Keychain profile:

```sh
VIKING_SIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)' \
  VIKING_UPDATE_PUBLIC_KEY='your public key' \
  bash manager/scripts/build-app.sh
bash manager/scripts/notarize.sh 'manager/dist/Viking Factory.app' your-notary-profile
```

Publish the exact signed `factory-manifest.json`, `factory-manifest.sig` and referenced archives as assets of the matching GitHub release. Do not change the manifest after signing. Source only releases are listed but cannot be installed automatically. No signing private key belongs in Git, app resources, diagnostics or release assets.

## Privacy and diagnostics

Access codes and raw local logs are private. Diagnostic export uses an allowlist of versions and health fields; it excludes paths, logs, environment variables, tokens and project content. The menu bar companion adds no website analytics. Daily update checks contact GitHub and are separate from agent model requests.
