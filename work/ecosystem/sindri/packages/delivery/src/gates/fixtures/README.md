# Brokkr report fixtures

Real `VerificationReport` JSON produced by Brokkr itself (Brokkr `main` 3ceedb8, CLI
`apps/cli/dist/bin.js verify --json`) on a copy of `brokkr/tests/fixtures/react-app` with the
`e2e-react` harness, then validated with `@brokkr/core`'s `VerificationReportSchema`:

- `brokkr-report.passed.json`: typecheck and unit passed, verdict `passed`.
- `brokkr-report.failed.json`: the same app with a TypeScript error, verdict `failed`.

The JSON content is exactly what Brokkr emitted; only Prettier re-wrapped it (repo formatting). Regenerate
them when Brokkr's report schema changes.
