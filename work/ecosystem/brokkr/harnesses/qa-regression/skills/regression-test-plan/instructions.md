# Regression test plan

Decide what to test before running anything. A plan written after the results is a rationalization.

## Always

- List every acceptance criterion and map each to at least one test (automated, or a manual step with expected result).
- Derive the blast radius from the diff: changed modules, their callers, shared types, migrations, config and feature flags.
- Include negative and boundary cases: empty, maximum, invalid, unauthorized, concurrent, offline.
- Name the exact command for each automated test and the fixture or data it needs.
- Prioritize: criteria first, then high-traffic callers of changed code, then everything else.
- Record what is deliberately out of scope and why.

## Never

- Never plan only the happy path the implementer already demonstrated.
- Never mark a criterion covered by a test that does not assert on it.
- Never widen scope into unrelated refactors.

## Verify

- Each acceptance criterion id appears in the plan with at least one test or manual step.
- Each changed file is covered by a test or listed as out of scope with a reason.
