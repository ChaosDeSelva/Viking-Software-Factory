# Error handling

Failures are part of the contract: typed internally, safe externally, visible to operators.

## Always

- Throw typed errors with a stable code; map them to HTTP status in one central handler.
- Return a consistent error body (code, message, request ID) with no stack or internals.
- Preserve the cause when wrapping errors; log once at the boundary with context.
- Set timeouts on every outbound call (`AbortSignal.timeout(ms)` with `fetch`, driver timeouts) and retry only idempotent operations with backoff and a cap.
- Handle rejected promises; register process-level handlers that log and exit.

## Never

- Never write an empty `catch` or catch only to log and continue silently.
- Never return 200 for a failure or 500 for a client mistake.
- Never leak SQL, file paths or dependency messages to clients.

## Verify

- Tests assert status, error code and body for each failure path, including a dependency timeout.
- No unhandled rejection or uncaught exception occurs in the test run.
