# Backend performance

Measure latency and queries before and after; fix the bottleneck you can show.

## Always

- Eliminate N+1 queries with joins or batched lookups and add indexes for new filter and sort columns.
- Bound every list, payload, queue and concurrency level.
- Stream large bodies and files instead of buffering them.
- Run independent I/O concurrently with `Promise.all` and a concurrency limit.
- Cache only with an explicit key, TTL and invalidation rule.

## Never

- Never block the event loop with synchronous file, crypto or JSON work on large inputs.
- Never add a cache without a way to invalidate it.
- Never optimize without a recorded baseline.

## Verify

- Recorded query count or latency for the target path improves versus the baseline.
- Tests still pass and results are unchanged.
