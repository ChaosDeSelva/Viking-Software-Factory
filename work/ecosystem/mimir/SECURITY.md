# Security policy

Mimir controls agents that can run commands and edit code on your machine, so security reports are
taken seriously.

## Reporting a vulnerability

There is no public issue tracker or hosted service. Open a file under `docs/issues/` marked
`security` with a description, reproduction steps and the affected commit. Do not publish exploit
details before a fix is available. Fixes are made on a branch and released with a CHANGELOG note.

## Supported versions

Only the latest 0.x release.

## Design summary

* Local only. The server binds `127.0.0.1` by default; a non loopback bind is refused without
  `MIMIR_ALLOW_REMOTE=1` and TLS.
* Bearer token auth on every route except `GET /v1/health`; token file mode 0600.
* `Origin` and `Host` checks against CSRF and DNS rebinding.
* Deny by default policy for privileged actions; humans approve, agents cannot.
* Secrets are redacted before storage and in exports; payloads are bounded.
* No telemetry.

The full analysis, with what is implemented versus planned, is in
[docs/security/threat-model.md](docs/security/threat-model.md). Anything marked planned there is not
a claim that the risk is handled.

## Out of scope

Anything that requires an attacker who already runs code as your user (they can read the token file
directly), and the security of HerdR, Claude Code, Codex or git themselves.
