# Compatibility

Brokkr follows semver. Before 1.0, minor versions may change contracts, but every change to the contracts below is listed in `CHANGELOG.md` and checked by `tests/contracts/`.

## Runtime support

| Component | Supported |
|---|---|
| Node.js | >= 25 (`engines`, checked by `brokkr doctor`) |
| OS | macOS arm64 (tested); Linux expected; Windows untested (`docs/limits.md`) |
| Package managers for checks | pnpm, npm (yarn and bun detected, not exercised) |
| Provider adapters | Claude Code (`SKILL.md`, descriptions capped at 1024 chars), Codex (`AGENTS.md`), generic |

## Public contracts

| Contract | Version | Where | Guarded by |
|---|---|---|---|
| CLI exit codes 0/1/2/3/4/130 | stable | `packages/core/src/errors.ts` | CLI exit code tests; `tests/contracts` (`EXIT_CODES`) |
| Harness, skill, profile, task, role manifests | `brokkr.dev/v1alpha1` | `packages/core/src/schemas.ts` | core schema tests; `brokkr harness validate` |
| Lockfile | `lockVersion: 2` (optional `profile { name, digest }` pin, covered by the digest) | `.brokkr/harness.lock.json`, `Selection.lock` | registry tests; v1 locks are rejected with a relock hint |
| Verification report | `schemaVersion: "1.0"` | `schemas/verification-report.v1.json` | `tests/contracts/src/schemas.test.ts` (stored v1 fixture, schema drift) |
| Verification events | `schemaVersion: 1` | `schemas/verification-event.v1.json` | `tests/contracts` (stored v1 event stream, live run) |
| SDK `Selection` | `schemaVersion: 1` | `schemas/selection.v1.json` | `tests/contracts` |
| SDK surface | 0.1 | `@brokkr/sdk`, `@brokkr/sdk/testing` | `tests/contracts/src/sdk-surface.test.ts` (runtime exports, `expectTypeOf` signatures) |
| `CheckExecutor` | 0.1 | `@brokkr/runner`, re exported by the SDK | contract types; ADR-004 |

### Evolution rules for v1 schemas

* **The published schemas are strict** (review I5 ruling): `additionalProperties: false` everywhere and closed enums, exactly matching what Brokkr itself accepts (`SelectionSchema` on `prepare`/`verify` input, `VerificationReportSchema` on stored reports). A document the schema accepts is a document Brokkr accepts, and vice versa; `tests/contracts` probes both sides (for example a selection with an extra `plannedBy` field is rejected by both).
* **Any change to a contract regenerates its schema file** (`pnpm --filter @brokkr/sdk schemas`), is listed in `CHANGELOG.md`, and is pinned by the contract tests. Consumers that validate with the published schema must take the new file with the new Brokkr version.
* **Breaking changes** (removing or renaming a field, changing a type, adding a verdict, changing the meaning of a verdict or exit code) need a new schema version file (`verification-report.v2.json`) documented alongside v1 for at least one release.

Queued changes from the B2 fix round: check reason `not_applicable`, a project level `allowNetworkFor` exception, and CLI `--exceptions`/`--policy` file options. They land with regenerated schemas.

## Upgrades

* After upgrading Brokkr or a harness, run `brokkr harness lock` and commit the new lock. A lock that no longer matches blocks verification by design.
* Stored runs remain readable: `brokkr report --run <id>` validates them against the current report schema; v1 reports are covered by the contract fixture.

## Release artifacts

`pnpm release:local` produces `dist/brokkr-<version>-<os>-<arch>.tar.gz`, a `.sha256` and `<name>.sbom.cdx.json`:

```
brokkr-0.1.0-macos-arm64/
  bin/brokkr              # launcher (needs node >= 25 on PATH)
  lib/                    # @brokkr/cli installed with `pnpm install --frozen-lockfile --offline` (hoisted; lockfile shipped)
  packages/*.tgz          # the SDK and its closure, plus manifest.json
  docs/api/               # TypeDoc API reference
  sbom.cdx.json           # CycloneDX SBOM of exactly the shipped lib/
  install-local.sh  README.md  CHANGELOG.md  SECURITY.md  LICENSE  VERSION
```

* **Offline and pinned**: third party versions are taken from the workspace lock (`pnpm list`) and pinned with overrides; every `@brokkr/*` package resolves to its local tarball. The lockfile is written offline and installed with `--frozen-lockfile --offline`; a package missing from the local store fails the release instead of being downloaded. `pnpm smoke:pack` installs its temp consumer the same way.
* **Reproducible**: entries are sorted, every mtime is `SOURCE_DATE_EPOCH` (default: the HEAD commit time), owner is uid/gid 0 with no names, extended attributes and macOS metadata are dropped, and gzip runs with `-n`. The SBOM's timestamp is the same epoch and its serial number is derived from its content. `pnpm release:repro` builds twice and requires byte identical archive and SBOM.
* `install-local.sh` refuses to install without a matching `.sha256` unless `--no-verify` is given.

The archive bundles no Node.js runtime; the `<os>-<arch>` suffix records where it was built and tested. It is not signed.
