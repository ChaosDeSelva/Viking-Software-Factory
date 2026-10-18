# Flaky test triage

A test that fails sometimes is either a real race in the product or a broken test. Find out which.

## Always

- Re-run a suspected flake in isolation and in the full suite, recording each outcome and seed.
- Check for shared state, ordering dependence, real time, randomness, network and unawaited promises.
- Treat a flake that touches changed code as a regression until proven otherwise.
- Quarantine only with an issue, an owner and an expiry; keep it visible in the report as skipped.
- Fix the root cause: fake timers, deterministic seeds, explicit waits on conditions, isolated fixtures.

## Never

- Never add blind retries or longer sleeps to make a test pass.
- Never delete a flaky test without replacing its coverage.
- Never count a retried pass as a clean pass in the evidence.

## Verify

- The flake rate before and after the fix is recorded (for example 20 consecutive runs).
- Quarantined tests are listed in the report with issue and owner.
