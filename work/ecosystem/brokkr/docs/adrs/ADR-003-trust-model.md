# ADR-003: Trust model for harness sources and generated files

* Status: accepted
* Date: 2026-10-14

## Context

Harnesses define commands that Brokkr will execute. Spec §5.1 says downloading a package must not authorise its commands.

## Decision

**Source precedence**

Sources load in this order: built in, user local (`~/.brokkr/harnesses`), project local (`.brokkr/harnesses`), then external sources pinned in `.brokkr/config.yaml`. If the same `name@version` exists in more than one source, the earlier source wins and a `shadowed` diagnostic is recorded.

Resolution orders candidates by precedence tier first and by semver only within a tier (fix round 1, review I3). A lower tier is used only when no higher tier has a version that satisfies the range. As a result, an external or project package cannot take over a built in name by publishing a bigger version.

**Trust**

Built in, user local and project local sources are trusted, because the user put them there. External sources are `untrusted` unless their config entry says `trusted: true`.

**Pinning**

Every external source carries a `sha256:` digest:

* A directory source uses its tree digest.
* A `.tgz` source uses the SHA-256 of the file. After the digest matches, the archive is listed with `tar -tzf` and `tar -tzvf` (review I2). It is rejected (`unsafe-archive`, nothing extracted) if any member:
  * has an absolute path or a `..` component;
  * is a symlink, hardlink or special entry;
  * lies outside a single top level directory.

  Every load extracts afresh into a staging directory and compares the result with the cached tree (review I1). On a mismatch:
  * a loud `tampered` diagnostic is emitted;
  * the cache is restored from the archive;
  * the source loads as untrusted.

  The listing check is tested against bsdtar (macOS). GNU tar prints the same type column but is untested in this repo.

A mismatch is handled by source type:

* **Directory source** (fix round 2, review N1): the source is marked `tampered` and a loud `TAMPERED` diagnostic is emitted. Its harnesses stay listable but load as untrusted, so `resolve` refuses them (`trust_required`) and `executionAllowed` is false.
* **Tarball source**: a changed `.tgz` is skipped entirely with an `integrity` diagnostic.

External pins hash every file. There is no exclusion mechanism.

**Untrusted harnesses**

* They can be listed and inspected.
* `resolve` refuses to select them with `trust_required` (exit 4) unless the caller passes `allowUntrusted: true`. In that case they resolve with `executionAllowed: false`, and `compose` reports `executionAllowed: false`.
* `prepare` refuses with `trust_required` (exit 4) before writing any skill text from an untrusted or tampered source.
* The runner refuses to execute their checks: an untrusted harness in the resolved set blocks the run (`untrusted_source`) before any command runs.
* `brokkr harness add` refuses them with exit 4 (policy denied).
* `brokkr trust add <source> --digest` recomputes the digest and records the source as trusted only on an exact match; a mismatch exits 4.

**Approval**

`brokkr init` explains each recommended harness (its checks, skills and policies) and asks for approval before writing configuration. `--yes` gives that approval non interactively. Declining exits 4 and writes nothing.

**Generated files**

Adapters write through `BundleWriter`, which records each file and its SHA-256 in `.brokkr-ledger.json`:

* Writes outside `cwd` are refused, after resolving symlinks. Writes through or onto symlinks, and overwrites of files Brokkr did not write, are also refused.
* Cleanup treats the ledger as untrusted input. An entry is deleted or rewritten only if all of these hold:
  * it resolves (via realpath) inside the bundle directory, or inside `cwd` when the caller explicitly allows project files;
  * it is a regular file and not a symlink;
  * its current digest still equals the recorded one.
* Anything else is skipped and reported.
* The project's own `CLAUDE.md`, `AGENTS.md` and `.claude/` are touched only with `modifyProjectInstructions: true`, and only as marked blocks or files Brokkr created.

## Consequences

* Trust is content addressed: changing a trusted directory invalidates its pin until it is trusted again.
* The standalone runner still cannot provide OS isolation (§8.3). `executionAllowed` is a policy gate, not a sandbox.

## Trust conferred by environment and repository (review M13; closed by the security audit, C1/C2)

Two inputs confer trust without a `brokkr trust add`:

* `BROKKR_BUILTIN_HARNESSES` redirects the trusted built in source.
* `<repo>/.brokkr/harnesses` is trusted as project local **in developer mode only**.

Precedence and lock verification do **not** protect against whoever controls the workspace: the workspace config can select any harness name, a missing lock was only a warning, and a lock in the workspace can be regenerated. The audit showed an agent written worktree passing verification with no real check. The fix is an explicit trust mode.

**Trust modes** (`loadContract` in `@brokkr/runner`, `verify --untrusted-workspace`, recorded as `trustMode` in every report):

* `developer` (CLI default): a developer verifying their own repository. Config, profiles, lock, exceptions and policy may come from the workspace; project local harnesses are trusted; a missing lock is a warning. Inputs read from the workspace are recorded as `workspace_supplied` policy sources.
* `workspace-untrusted` (library default, and what Mimir must use for an agent's worktree):
  * config, profiles, lock, exceptions and project policy are read **only** from caller supplied files/objects (`--config`, `--lock`, `--exceptions`, `--policy`) or the user config dir `~/.brokkr/`; the workspace's `.brokkr/config.yaml`, `harness.lock.json` and `exceptions.yaml` are never read (a warning notes they were ignored);
  * a caller path that resolves inside the workspace is refused (`invalid-config`);
  * project local harnesses load as untrusted, so `resolve` refuses them (`trust_required`, exit 4) and they never execute;
  * a missing or mismatching lock blocks the run (`lock_integrity`), never a warning;
  * exceptions count only when `approvedBy` is a caller supplied approver identity (`--approver`), and they may waive only checks that organization or project policy (supplied from outside the workspace) marks waivable; harness declared `waivable` flags are ignored (ADR-006).

A configured profile may never shadow a built in profile name (both modes).

**State written by Brokkr** (audit I2, I6): verification runs are stored outside the workspace in `~/.brokkr/runs/<sha256(realpath(workspace))>/` and their evidence manifests are HMAC signed with a per install key `~/.brokkr/key` (mode 0600, created on first use; refused if group/world readable or a symlink). Readers reject unsigned, re signed, foreign key and future dated runs. The signed manifest also binds the workspace identity (sha256 of the canonical workspace path) and the canonical runs root, so a run copied into another workspace's store, or moved to another runs root, is rejected (fix round 2, I4). Every Brokkr state directory (`~/.brokkr/runs/...`, `<repo>/.brokkr`, `<repo>/.brokkr/cache/sources`) is created through `ensureSafeDir`, which lstat checks every component and refuses symlinks; `runs prune` never follows a symlinked run directory.

**Brokkr home isolation** (fix round 2, I3): in `workspace-untrusted` mode every check runs with a per run scratch `HOME` and `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME`, never the real home. The Brokkr home (`<home>/.brokkr` except its run store: config, lock, exceptions, org policy, user harnesses, key) is snapshotted before any check and digest compared after; any change blocks the run with `home_tampered`. A check therefore cannot plant `~/.brokkr` defaults for the next untrusted run through `$HOME`, and writing to the real path by guessing it is detected.

Recommendation for Mimir: pass every check it relies on in `requiredCheckIds` (organization or project policy from outside the workspace), so that the work under test cannot make a check `not_applicable` by deleting its guard file (ADR-005), and pass explicit `--config/--lock/--exceptions` rather than relying on `~/.brokkr` defaults.

What this does not protect against: a process running as the same OS user can still read `~/.brokkr/key` and forge runs by absolute path, and the local executor is not a sandbox (ADR-004). Isolation from the agent needs a separate user or a sandbox executor.
