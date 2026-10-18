# Local issue index

One file per epic. No GitHub remote exists (user decision 2026-10-14), so these files are the tracker. Status refreshed 2026-10-14 by T15d from the code on main (06f0722) and the merge history. Merged: T2 to T13, T14a, Tperf and fix rounds. T12fix merged (f4b12a6). Open lanes at this date (not counted as done): T12b, T14b, Msec, README. "Partial" means some acceptance work is merged and the rest is named in the file. Unchecked acceptance boxes have not been re run by a reviewer for this refresh.

Statuses: done, partial, in progress, not started. Epic definitions: `02_MIMIR.md` (M01..M18) and `01_HERDR_INTEGRATION.md` (H01..H08).

| Epic | Title | Status | Task(s) |
|---|---|---|---|
| [M01](M01-scaffold-ci.md) | Scaffold and CI | done | T2 |
| [M02](M02-schema-sdk.md) | Schema and SDK | partial | T3, T6, T7 merged; five served routes not yet in the contract |
| [M03](M03-db-event-store.md) | Database and event store | done | T4 |
| [M04](M04-fake-runtime.md) | Fake runtime integration | done | T5 |
| [M05](M05-herdr-adapter.md) | HerdR adapter integration | done | T8 merged |
| [M06](M06-project-onboarding.md) | Project onboarding | partial | T6, T12, T15b merged; doctor does not read integration.list |
| [M07](M07-scheduler.md) | Mission scheduler | done | T9, T12 merged |
| [M08](M08-crews-tasks.md) | Crews and tasks | done | T9, T12 merged |
| [M09](M09-worktree-lifecycle.md) | Worktree lifecycle | done | T10, T12 merged |
| [M10](M10-sse-timeline.md) | SSE timeline | done | T6, T13 merged |
| [M11](M11-agent-inspector.md) | Agent inspector | partial | T12, T13 merged; real HerdR terminal path unproven |
| [M12](M12-approvals-policy.md) | Approvals and policy | partial | T11, T12, T12fix merged |
| [M13](M13-artifacts-review.md) | Artifacts and review | partial | T12, T13, T12fix merged; no real remote PR run |
| [M14](M14-costs-budgets.md) | Costs and budgets | partial | T9, T12 merged; measured usage needs hooks |
| [M15](M15-restart-recovery.md) | Restart recovery | partial | T12, T14a merged; real HerdR restart unproven; T14b |
| [M16](M16-security-hardening.md) | Security hardening | partial | T4, T6, T10, T11, T14a merged; T14b and Msec open |
| [M17](M17-packaging-docs.md) | Packaging and docs | done | T15a d; README on task/README |
| [M18](M18-e2e-release.md) | End to end release tests | partial | T13, T15d; no real HerdR release e2e |
| [H01](H01-capability-audit.md) | Source and capability audit | done | T1, T2 |
| [H02](H02-adapter-interface-fake.md) | Typed adapter interface and fake runtime | done | T3, T5 |
| [H03](H03-session-create-input.md) | Session create, discover, input | done | T8 merged |
| [H04](H04-event-normalization.md) | Event normalization and replay | done | T8 merged |
| [H05](H05-stop-restart-reconcile.md) | Stop, restart and reconcile | partial | T8, T12 merged; real HerdR restart unproven |
| [H06](H06-security-error-mapping.md) | Security and error mapping | done | T8 merged |
| [H07](H07-contract-failure-tests.md) | Contract and failure tests | partial | T8, T14a merged; T14b open |
| [H08](H08-os-matrix.md) | OS compatibility matrix and install docs | partial | T15c, T15d; macOS arm64 only |

Task map: T1 spike, T2 scaffold, T3 protocol, T4 event store, T5 fake runtime, T6 server API, T7 SDK, T8 adapter, T9 scheduler, T10 git, T11 policy, T12 orchestration, T13 web UI, T14 chaos and security tests, T15a ADRs, threat model and these issues, T15b CLI, user docs, packaging, gate doc, T15d real start/demo, static web serving, docs refresh.

Sindri (F01..F18) and Brokkr (BRK-001..020) epics are tracked in their own repositories.
