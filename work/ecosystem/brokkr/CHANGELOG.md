# Changelog

All notable changes to Brokkr. The format follows Keep a Changelog; versions follow semver. Public contracts (CLI exit codes, report schema, SDK surface, manifest schema) are listed in `docs/compatibility.md`.

## 0.1.0 (2026-10-14), first local alpha

### Fixed before release

* Policy checks now recognize mixed case and aliased executables, command bearing Git config after global option operands, and additional inline code channels. Waivers cannot weaken higher precedence requirements, regardless of caller layer order.
* Untrusted checks receive a scratch home. Changes to the Brokkr home block verification. Evidence manifests bind the workspace and run store location; older manifests without these bindings are rejected and require a new verification run.
* Run directory integrity is checked before artifact scanning as well as finalization, preventing a swapped run directory from redirecting redaction writes into unrelated files.

* Locks resolved with a profile before the profile pin existed carry no pin; a selection naming a profile against such a lock is blocked with `lock_integrity`, so re resolve them. Harness request order inside a profile does not affect its pin.
* Hard linked bundle files are refused by the bundle scan, and `brokkr verify` uses the same reader as the SDK.
* The SDK lock pins the profile: `HarnessLock.profile { name, digest }` (optional; covered by the lock digest; profile less locks keep their digest). An earlier commit message (`69d989e`) claimed profile pinning before it existed; it was added in B3b fix round 2.
* Generated bundle secret scanning happens after the checks, with `O_NOFOLLOW` opens and `fstat` containment, so a check cannot swap a bundle file for a symlink to a host file.

### Added

* **Harness registry** (BRK-002..004): `brokkr.dev/v1alpha1` harness, skill, profile, task, role and lockfile schemas; built in, user, project and digest pinned external sources (directories and vetted `.tgz`); trust model with `brokkr trust`; composition with conflict detection; `lockVersion: 2` lockfile over every file of every harness.
* **Skill resolver** (BRK-005): deterministic scoring, dependency closure, conflicts, token budget and a reason for every selected and rejected skill; repository inspection.
* **Provider adapters** (BRK-006, BRK-007): Claude Code (`SKILL.md`), Codex (`AGENTS.md`) and generic bundles with ledger based, tamper aware cleanup.
* **Verification** (BRK-008..011): `brokkr verify` with `LocalProcessExecutor` (argv only, confined cwd, environment allowlist, process group kill on timeout and Ctrl C, bounded logs), layered policy engine with approval exceptions, secret redaction, verdicts `passed | failed | incomplete | blocked`, run evidence with a SHA-256 manifest verified on read, JSON/Markdown/offline HTML reports, `brokkr report` and `brokkr runs`.
* **Public SDK** (BRK-012): `@brokkr/sdk` with `Brokkr.resolve`, `prepare`, `cleanup`, `verify` (injected `CheckExecutor`, streaming `verification.*` events with correlation ids and per run sequence numbers), `readReport`, `listHarnesses`, `inspectRepo`; `@brokkr/sdk/testing` `MockExecutor`; trust modes with `workspace-untrusted` as the default (the verification contract comes from the caller: `harnesses`, `profiles`, `lock`, `exceptions`, `policy`) and `developer` opt in; JSON Schemas `verification-report.v1.json` and `verification-event.v1.json`.
* **Built in harness library** (BRK-013..015, BRK-018): P0 `frontend-react`, `backend-node`, `security-baseline`, `documentation`, `qa-regression`; P1 `database-postgres`, `backend-kotlin-spring`, `godot-game`; profiles `frontend-strict`, `backend-strict`, `fullstack`.
* **Integration contracts** (BRK-016, BRK-017): `examples/mimir-integration` (orchestrator with an injected worktree executor consuming events) and `examples/sindri-integration` (planning without execution); consumer contract tests in `tests/contracts/`.
* **Docs and release** (BRK-019, BRK-020): user, authoring, SDK, security and limits docs; generated API docs; `pnpm pack:local` tarballs; `pnpm release:local` reproducible, offline, lockfile pinned archive with checksum, SBOM of the shipped tree and smoke test; `pnpm release:repro`; `scripts/install-local.sh` (fails closed without a checksum).

### Known limitations

See `docs/limits.md`: no OS sandbox, best effort network denial, Windows untested, release archives not signed, name/trademark check pending.
