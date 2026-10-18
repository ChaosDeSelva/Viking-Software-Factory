# Test evidence

A result nobody can audit is not evidence. Record enough that a reviewer can trust the outcome without re-running.

## Always

- Record for each run: commit SHA, command, environment (OS, runtime versions), start time, duration, exit code.
- Keep the raw log and the machine-readable results (JUnit XML, JSON) next to the summary.
- Attach screenshots or traces for UI checks at the viewports the plan names.
- Summarize counts: passed, failed, skipped, with the reason for every skip.
- Map results back to acceptance criterion ids.
- Redact secrets and personal data before saving logs or screenshots.

## Never

- Never paraphrase output where the exact text matters; paste it.
- Never report "all tests pass" without the counts and exit code.
- Never hide skipped or quarantined tests inside a passing total.
- Never edit evidence files after recording them.

## Verify

- The summary's counts match the raw results file.
- Every acceptance criterion links to at least one evidence item.
