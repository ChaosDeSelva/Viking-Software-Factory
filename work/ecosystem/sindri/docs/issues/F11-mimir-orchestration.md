# F11: Mimir SDK orchestration

Status: Merged, fixes in progress

Implemented in: `packages/mimir-client`, `packages/delivery` (task S5); fix round S5fix in progress

Review found a stuck ask escalation, hung re created executions and silently dropped budgets. Follow up S5b (done): the `create-task` shim is replaced by the SDK's `tasks.create`, tarballs are re vendored, crew budgets are forwarded. The live test is gated by `MIMIR_LIVE`.
