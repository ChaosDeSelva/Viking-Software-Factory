# Security policy

Brokkr executes commands defined by harnesses against real repositories, so security problems are release blocking (spec §16, §21.4).

## Supported versions

| Version | Supported           |
| ------- | ------------------- |
| 0.1.x   | Yes (current alpha) |

## Reporting a vulnerability

This project is developed locally and has no public tracker. Report a vulnerability by opening a file under `docs/issues/` named `SECURITY-<short-title>.md` and marked `security` in its first line. Include:

* the Brokkr version (`brokkr --version`) and platform;
* a minimal harness, task file or repository that reproduces the problem;
* what you expected and what happened (exact commands and output).

Security issues are triaged before all feature work. Do not disclose details elsewhere until a fix is available.

## In scope

* A check running despite policy denial, an untrusted source or a tampered lock.
* A skipped, errored, timed out or cancelled required check reported as passed.
* Escaping the workspace (cwd, symlinks, `..`), the bundle directory or the ledger boundary.
* Secrets leaking into instruction bundles, logs, reports or events.
* Evidence that can be altered without `readReport` detecting it.
* Command or shell injection through manifests, task files or SDK input.

## Known limitations (not vulnerabilities by themselves)

Brokkr's local executor is not an OS sandbox; network denial is best effort. See `docs/limits.md` and the threat model in `docs/security.md`.
