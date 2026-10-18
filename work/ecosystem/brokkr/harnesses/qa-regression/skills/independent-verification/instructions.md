# Independent verification

QA exists to find what the implementer missed. Treat their report as a claim to check, not evidence.

## Always

- Start from a clean checkout of the exact commit or worktree under test; record the commit SHA.
- Re-run the project's tests yourself and read the real exit code and output.
- Reproduce every reported fix: run the failing scenario before and after where possible.
- Explore beyond the plan for at least the riskiest changed path: odd inputs, repeated actions, slow network, small screens.
- Write a new failing test for each defect you find, then hand the defect back with exact reproduction steps.

## Never

- Never copy pass/fail results from the implementer's summary or an agent transcript.
- Never fix product code yourself while acting as QA; report it.
- Never re-run a failing test until it passes and call it green.
- Never weaken an assertion or delete a test to make a run pass.

## Verify

- Every result in your report came from a command you ran, with its exit code.
- Every defect has a reproduction command or steps and a test that fails on the defective build.
