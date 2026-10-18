# M16: Security hardening

Status: **partial**
Phase and gate: Phase 2 / G2
Owning task(s): T4, T6, T10, T11, T14a
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): Token auth, Origin/Host checks, allowed roots, payload and depth bounds, credential refusal, redaction, exact allowlist policy and git hardening are merged with tests under `apps/server/test/security` and `test/chaos` (see `docs/gates/phase-2-gate.md`).

Redaction, bounded payloads, policy deny by default, classifier, untrusted text detection, loopback bind config. Threat model: `docs/security/threat-model.md`.

## Remaining
Orchestration level security scenarios are on `task/T14b`; secret exposure hardening on `task/Msec`.

## Acceptance tests
* [ ] Path traversal, symlink, credential in logs, Origin spoofing, wrong token, bounded payload, prompt injection fixtures all pass (T14).

## Commits (local repository, no remote)
60a23ce, 2612ebc, d1f45be
