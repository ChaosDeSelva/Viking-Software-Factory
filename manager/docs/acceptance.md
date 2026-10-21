# Local preview acceptance

Validated on an Apple silicon Mac on October 20 and 21, 2026. This is evidence for the manager preview, not a claim that every factory integration has live acceptance.

## Passed

1. Thirteen Rust lifecycle and security tests: installation, update, data rollback, interrupted activation recovery, rollback journal retention, corrupt archives, internal and escaping links, path traversal, signature verification, untrusted update rejection, exclusive operations, release selection, unmanaged directory protection and occupied port protection. Several tests cover more than one case.
2. A built runtime bundle installed into disposable private state with core services, Hulder, Bifrost and Skidbladnir. Mimir, Sindri, Heimdall and the simulator started on isolated ports.
3. An update of the running installation restarted its services. Manual rollback restored the prior release and its data, and both core services and the simulator restarted afterward.
4. An authenticated Codex task ran through the installed Mimir runtime. It created hello.txt with the expected greeting and completed its npm test verification contract. This used a disposable repository and existing agent authentication.
5. Uninstall removed only managed application releases and retained data and backups.
6. The final 0.2.0 preview bundle installed into a fresh disposable root, including its companion package. Core and simulator startup passed. Its bundled npm reported 11.17.0.
7. A live unsettled mission caused the manager to refuse stop; cancellation of that disposable mission allowed a clean stop.
8. Native companion buttons and health output were inspected through macOS accessibility APIs. Both local agent authentication checks passed.

9. The patched ZIP 9 runtime passes the thirteen manager tests. The resolved manager dependency scan reports no advisories across 69 registry dependencies. Seven worker API and lifecycle regression tests also pass.

## Published distribution acceptance

On October 21, the public v0.2.0 preview was downloaded through the manager from GitHub. A disposable installation with a synthetic older version label was running before the update. All five package archives downloaded, the pinned Ed25519 signature and checksums verified, version 0.2.0 activated and services restarted. This verifies the real remote update path; the synthetic baseline does not claim a migration from a historical public binary.

The companion and bundled Hulder are Developer ID signed, notarized and stapled. The public Hulder v0.1.1 disk image was downloaded separately, its checksum and stapled ticket verified, and its mounted app passed Gatekeeper. Hulder opening, editing and saving passed with isolated user state. The factory manager macOS CI run 39562966894 passed its Rust tests and Swift compilation.

## Remaining manual acceptance

Manual VoiceOver announcements, login registration and installation on a separate clean Mac are not claimed as passed. Agent authentication remains an interactive prerequisite. Cloud provisioning and vendor integration acceptance are outside these manager checks.

The manager installs prebuilt bundles; it does not clone or pull source repositories. No existing factory installation or cloud resource was changed by the disposable distribution acceptance.
