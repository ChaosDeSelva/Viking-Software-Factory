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

## Remaining distribution checks

Apple Developer ID and an existing notarization profile are available outside the execution sandbox. The separate factory companion artifact is now Developer ID signed, Apple notarization Accepted, ticket stapled and Gatekeeper accepted. Its update public key is pinned at build time and the bundle manifest is signed. Publishing installable assets and accepting a live downloaded update remain outstanding.

A live update download from a published factory release has not been accepted because no installable release assets have been published. Signature verification and activation recovery are covered locally. Login registration, manual VoiceOver announcements and installation on a separate clean Mac are not claimed as passed.

The manager installs prebuilt bundles; it does not clone or pull source repositories. Agent authentication remains an interactive prerequisite. Cloud provisioning and vendor integration acceptance are outside these manager checks.
