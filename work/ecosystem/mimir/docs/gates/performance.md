# Performance and load gate

Roadmap nonfunctional targets for Mimir, how they are measured, and the last observed results.

| Roadmap target | How it is checked | Result |
|---|---|---|
| Fleet UI updates under 1 s after a structured event | SSE end to end p95 (append called -> frame parsed by a real socket client) in scenarios 1 and 2 | met: 0.63 ms (20 sessions), 9.47 ms (50 clients, last notified client) |
| Reconnect without missing durable events | Scenario 1 drops a UI client half way and reconnects it with its `Last-Event-ID` after 500 ms; scenario 2 starts a late joiner mid run from a cursor a quarter of the way in | met: 0 missed or duplicated, 0 replay mismatches over 7500 events |
| 20 concurrent sessions on a developer workstation | Scenario 1: 20 FakeRuntime sessions x 10 events/s x 30 s through a file backed (WAL) store and the real server | met: 6000/6000 events, append p95 0.34 ms, event loop delay p99 11.89 ms |
| No uncontrolled background model calls | Structural: no outbound HTTP client (`fetch(`, `http(s).request`, `undici`) in non test code of `apps/server/src`, `packages/core`, `packages/protocol`, `packages/fake-runtime` (grep, 2026-10-14). Not a benchmark | met (structural check only) |

No target was missed, so no production code was changed for performance.

## How to run

```sh
pnpm bench          # report mode: machine description and the results table
pnpm bench:check    # CI mode: same, exits 1 if any threshold is missed
pnpm --filter @mimir/server bench -- --only=fanout,store --scale=0.1 --json=/tmp/bench.json
```

* The root scripts build the server's workspace dependencies with turbo, then run
  `apps/server/bench/run.ts` under `node --expose-gc --import tsx`. `--expose-gc` makes the heap
  readings stable (a full GC runs before each reading).
* Flags: `--check`; `--scale=<0..1>` shrinks counts and durations (1 = the roadmap scenarios);
  `--only=<name,...>` with names `sustained, scheduler, tick, fanout, store, rebuild, idempotency`;
  `--json=<path>` writes machine plus results.
* Everything runs in one process: the real Fastify server from `buildServer` listening on an
  ephemeral loopback port, real HTTP/SSE sockets, FakeRuntime, and an in memory or temp file store.
  Client parsing shares the event loop with the server, so latencies are conservative.
* `apps/server/bench/bench.test.ts` runs every scenario at scale 0.01 inside `pnpm check`. It
  asserts only the exact count thresholds (drops, misses, duplicates, executed once), so the
  scripts cannot rot without making the unit gate flaky.
* Helpers live in `packages/testing/src/bench/`: `summarize`/`percentile` (nearest rank),
  `evaluate`/`meets`/`formatTable` (thresholds as assertions), `describeMachine` (CPU via
  `sysctl -n machdep.cpu.brand_string` on macOS), `heapUsedBytes`, and `openBenchSse` (an SSE client
  that counts events without keeping bodies, so 50 clients do not distort heap readings).

Thresholds marked **roadmap** come from the roadmap. Thresholds marked **guard** are regression guards
set with a wide margin over the numbers below (typically 10x to 1000x), so a loaded CI machine does
not flake.

## Scenarios

1. **sustained**: 20 FakeRuntime sessions, each scripted to emit `session.output` every 100 ms for
   30 s (6000 events). A real time driven `ManualClock` paces them, with sessions staggered by 5 ms.
   A bench bridge appends each runtime observation to a file backed store, standing in for the
   orchestrator's ingest. Two SSE "fleet UI" clients are connected; one disconnects half way and
   reconnects with `Last-Event-ID`.
   * **Scheduler tick:** `scheduler` times the pure `schedule()` from `@mimir/core` (the decision
     half of a tick) over 20 running tasks, 40 pending tasks in a dependency chain, 20 leases,
     2000 usage samples and 2 budgets.
   * **Orchestrator tick** (`tick`, added by T14b once T12 landed): the full
     `Orchestrator.tick()` in the real server from `buildServer`: approval expiry, ready
     promotion, lease heartbeats, `schedule()`, applying its decisions and budget checks. The
     mission has 20 running tasks (FakeRuntime sessions that stay `running`), 40 pending tasks in
     a dependency chain, 2000 measured usage samples and a hard mission budget. Git is stubbed
     (a tick never touches git; 20 real worktrees would only time the setup). The fake clock
     moves 100 ms before each tick so heartbeats renew every lease. Also reported: running tasks
     still running after all ticks (must be 20) and events appended by steady-state ticks.
2. **fanout**: 50 live SSE clients and 10k events appended in bursts of 50 every 5 ms on an
   in memory store. Measured:
   * drops (`event: gap`/`error`);
   * events missed by the worst client;
   * the final `id` on every client;
   * peak and settled heap delta;
   * SSE latency on the last subscribed client, which is notified last.

   A late joiner connects when half the events are appended, with `Last-Event-ID` at event 2500.
   Its replay overlaps live delivery, and the 7500 event ids it receives are compared, in order,
   with the ids appended.
3. **store**: 100k mixed events appended to a file backed store in transactions of 1000. Then:
   * full `read` pagination with limit 500, unfiltered and filtered by one stream;
   * 10k calls to `earliestCursor`, timed both before and after pruning half the log.
4. **rebuild**: 100k mixed events on disk. The store is reopened, and two things are timed:
   `ReadModel.load` alone, and the whole `buildServer` boot until listening.
   * Event mix: 1% `mission.created`, 10% `session.state_changed`, 89% `session.output`.
   * The current read model projects missions and ignores output, so the fold mostly costs
     store reads plus payload validation. In this log, 10k `session.state_changed` events
     reference unknown sessions and are skipped.
5. **idempotency**: 200 parallel identical `POST /v1/projects` over real sockets: same
   `Idempotency-Key`, same body, real temp git repo. A second wave of 200 follows once the first
   settles.
   * Pass condition: exactly one request executes, one project and one `project.create` audit
     entry exist, and every other response is a 201 replay or a 409 `conflict` (in flight).
   * The 409s are the documented T6 behaviour for a key whose command is still running. The
     handler awaits `git rev-parse`, so early arrivals see it in flight.

## Last run

Run: 2026-10-14, branch `task/Tperf`, `pnpm bench:check` (scale 1), exit 0. The `tick` rows
come from a later run on branch `task/T14b` (`pnpm --filter @mimir/server bench --only=tick`,
scale 1, 500 ticks, load average 11.79 9.66 8.17 at the start).

Machine:
* CPU: Apple M4 Pro, 14 cores (`sysctl -n machdep.cpu.brand_string`)
* Memory: 24 GB (`hw.memsize` 25769803776)
* OS: darwin arm64, Node v25.9.0
* Load average: 8.83 8.72 8.52 at the start, 8.11 8.52 8.46 at the end. Other agents' test runs
  were active on the machine, so these numbers come from a loaded workstation.

| Scenario | Metric | Value | Target | Status |
| 1 sustained | events appended | 6000 events | >= 6000 (guard) | PASS |
| 1 sustained | append throughput | 199.59 events/s | - | - |
| 1 sustained | store append p50 | 0.18 ms | - | - |
| 1 sustained | store append p95 | 0.34 ms | < 25 (guard) | PASS |
| 1 sustained | store append p99 | 1.11 ms | - | - |
| 1 sustained | SSE e2e p50 | 0.3 ms | - | - |
| 1 sustained | SSE e2e p95 | 0.63 ms | < 1000 (roadmap) | PASS |
| 1 sustained | SSE e2e p99 | 1.37 ms | - | - |
| 1 sustained | SSE e2e max | 3.09 ms | - | - |
| 1 sustained | events missed per UI client | 0 events | == 0 (roadmap) | PASS |
| 1 sustained | reconnecting client: events missed or duplicated (dropped at 3002, 500 ms offline) | 0 events | == 0 (roadmap) | PASS |
| 1 sustained | gap/error frames | 0 count | == 0 (guard) | PASS |
| 1 sustained | event loop delay p99 | 11.89 ms | - | - |
| 1 scheduler (decision only) | schedule() p50 (20 running) | 0.03 ms | - | - |
| 1 scheduler (decision only) | schedule() p95 | 0.03 ms | < 50 (guard) | PASS |
| 1 scheduler (decision only) | schedule() p99 | 0.05 ms | - | - |
| 1 tick (orchestrator) | tick p50 (20 running, 40 pending, 2000 samples) | 0.14 ms | - | - |
| 1 tick (orchestrator) | tick p95 | 0.19 ms | < 100 (guard) | PASS |
| 1 tick (orchestrator) | tick p99 | 0.27 ms | - | - |
| 1 tick (orchestrator) | running tasks kept by heartbeats | 20 tasks | == 20 (guard) | PASS |
| 1 tick (orchestrator) | events appended by steady ticks | 0 events | - | - |
| 2 fan out | clients | 50 clients | - | - |
| 2 fan out | produce rate | 4705.39 events/s | - | - |
| 2 fan out | all clients caught up | 2125.42 ms | - | - |
| 2 fan out | fan out deliveries | 235247.75 events/s | - | - |
| 2 fan out | append + fan out notify p95 | 0.12 ms | - | - |
| 2 fan out | SSE e2e p95 (last notified client) | 9.47 ms | < 1000 (roadmap) | PASS |
| 2 fan out | SSE e2e p99 (last notified client) | 23.42 ms | - | - |
| 2 fan out | clients dropped (gap/error) | 0 clients | == 0 (roadmap) | PASS |
| 2 fan out | events missed (worst client) | 0 events | == 0 (roadmap) | PASS |
| 2 fan out | clients with wrong final id | 0 clients | == 0 (guard) | PASS |
| 2 fan out | heap delta (peak) | 52.78 MB | < 200 (roadmap) | PASS |
| 2 fan out | heap delta (settled, after GC) | -0.15 MB | - | - |
| 2 fan out | late joiner replay mismatches (7500 expected) | 0 events | == 0 (roadmap) | PASS |
| 3 store | bulk append throughput (batches of 1000) | 44323.31 events/s | - | - |
| 3 store | read pagination throughput (limit 500, 100000 events) | 1180930.34 events/s | > 20000 (guard) | PASS |
| 3 store | read page p95 (limit 500) | 0.47 ms | - | - |
| 3 store | events read (all pages) | 100000 events | == 100000 (guard) | PASS |
| 3 store | stream filtered read throughput (5000 events) | 590958.36 events/s | - | - |
| 3 store | earliestCursor p50 | 1.08 us | - | - |
| 3 store | earliestCursor p95 | 1.29 us | < 1000 (guard) | PASS |
| 3 store | earliestCursor p95 after pruning half | 1.25 us | < 1000 (guard) | PASS |
| 4 rebuild | store open + migrate check | 1.27 ms | - | - |
| 4 rebuild | read model fold (100000 events) | 142.64 ms | - | - |
| 4 rebuild | fold throughput | 701072.99 events/s | - | - |
| 4 rebuild | server boot to listening | 134.83 ms | < 10000 (guard) | PASS |
| 5 idempotency | requests executed (not replayed) | 1 requests | == 1 (roadmap) | PASS |
| 5 idempotency | projects created | 1 projects | == 1 (roadmap) | PASS |
| 5 idempotency | project.create audit entries | 1 entries | == 1 (guard) | PASS |
| 5 idempotency | unexpected statuses (not 201/409) | 0 responses | == 0 (roadmap) | PASS |
| 5 idempotency | wave 1: 409 in flight | 68 responses | - | - |
| 5 idempotency | wave 1: 201 replayed | 131 responses | - | - |
| 5 idempotency | wave 1 latency p95 | 88.36 ms | - | - |
| 5 idempotency | wave 2: 201 replayed | 200 responses | == 200 (guard) | PASS |
| 5 idempotency | wave 2 latency p95 | 20.52 ms | < 1000 (guard) | PASS |

thresholds: 24 passed, 0 failed, 26 informational

## Targets missed

None. Observations that are not misses:

* **Producer rate in fan out (about 4.7k events/s).** Production is bounded by the 5 ms pacing
  timer and by the synchronous fan out inside `append`: store listeners run after commit, on the
  appending call stack. With 50 clients, append plus notify was 0.12 ms p95, which is not a
  hotspot.
* **Per client `JSON.stringify` in SSE `send`.** `frame()` in `routes/events.ts` serialises each
  event once per client, and `decodeCursor` also runs per client. At 50 clients this is inside the
  0.12 ms above, so per instructions it was left alone. If client counts grow by an order of
  magnitude, the first candidate is to cache the frame per event, since all listeners receive the
  same envelope object.
* **SSE replay.** Replay uses one `cursorsOf` query per page, not one per event, so there is no
  per event SQL in SSE.
* **`earliestCursor`.** It is `MIN(global_seq)` on a UNIQUE indexed column, about 1 us, and pruning
  does not change that.
