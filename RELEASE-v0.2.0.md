# Viking Factory 0.2.0 preview

Native Mac companion and coordinated factory installation for Apple silicon, macOS 13 or newer.

## Install

Download Viking-Factory-Setup-0.2.0-macos-arm64.zip from this release and extract it. Move Viking Factory.app to Applications. Open it, select optional components and choose Install bundle. Select factory-manifest.json inside the extracted bundle directory. Run Health check, authenticate your agent tools, then Start factory and Open Heimdall. Keep the private access codes local.

Node, npm and factory runtime dependencies are bundled. Git and authenticated Codex or Claude Code tools are separate prerequisites. Installation creates no cloud resources. Use Preview updates for this experimental release. Check updates and Apply update download signed coordinated releases from GitHub.

The separate app ZIP is a small download for existing installations. The package ZIP files, signed manifest and signature are updater assets; the setup ZIP includes them together for first installation.

## Verified scope

Developer ID signing, Apple notarization, stapling and Gatekeeper acceptance passed for the companion and Hulder. Manager CI passes, including thirteen Rust tests and the Swift build. Local installation, service startup, a real Codex task, update restart, rollback, recovery and refusal to stop an active mission passed. Seven worker lifecycle regression tests passed. See manager/docs/acceptance.md for evidence and distribution acceptance updates.

## Boundaries

Manual VoiceOver, login registration and a separate clean Mac acceptance remain pending. Vendor integrations without authenticated live acceptance remain experimental. This is a preview, not universal compatibility certification. Existing cloud acceptance covers specific disposable environments and is not rerun by installation.

Project data is stored separately from versioned software. Uninstall retains data and backups. Upstream licenses and dependency notices remain included. Hulder uses its independent v0.1.1 release; the package name follows the coordinated bundle version.
