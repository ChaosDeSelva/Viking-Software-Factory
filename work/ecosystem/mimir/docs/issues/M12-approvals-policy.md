# M12: Approvals and policy

Status: **partial**
Phase and gate: Phase 2 / G2
Owning task(s): T11, T12
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): Approval routes (`GET /v1/approvals`, `POST /v1/approvals/:id/decision`) are served and enforced: gated commands wait for a human, rejecting records `policy.denied` (`orchestrator/e2e.test.ts`), the default policy is the exact allowlist gate (ADR-014).

Privileged action list, deny by default `evaluate()`, `ApprovalService` with expiry, no self approval and human only decisions, shell command classifier, untrusted instruction detector, policy domain events. 270 core tests.

## Remaining
Per project `allowedCommands` is wired and approvals are consumed once (T12fix, merged); `Approval` still lacks `requestedBy` and `payloadSummary`.

## Acceptance tests
* [ ] 403 names the denying rule.
* [ ] A denied privileged command is proven not executed (FakeRuntime never receives `createSession`) (T14).
* [ ] `context.untrustedText` cannot change a decision.

## Commits (local repository, no remote)
8cf8045..2612ebc (merged d671828)
