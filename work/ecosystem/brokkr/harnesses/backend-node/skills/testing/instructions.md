# Backend testing

Test behavior through public interfaces. Unit-test logic; integration-test boundaries.

## Always

- Write the failing test first and confirm it fails for the intended reason.
- Unit-test pure logic with no I/O; test endpoints through the HTTP layer (inject or supertest).
- Run integration tests against real dependencies (a disposable database) with per-test isolation and cleanup.
- Control time, randomness and network with fakes at the boundary.
- Cover success, validation failure, authorization failure and dependency failure.

## Never

- Never share mutable state or depend on test order.
- Never mock the module under test or assert on private internals.
- Never skip or `.only` a test in committed code.
- Never call real third-party services.

## Verify

- `pnpm test` passes twice in a row with no flakes.
- Each changed endpoint and branch has a test that fails when the behavior is reverted.
