# Architecture Decision Records

Each ADR has context, decision, consequences and status. Decision IDs `D-001`..`D-012` come from `05_ROADMAP_PLAN.md`; the ADR number is not the D number except where noted.

| ADR | Title | Source | Status |
|---|---|---|---|
| [001](ADR-001-typescript-end-to-end.md) | TypeScript end to end | D-001 | Accepted |
| [002](ADR-002-mimir-owns-worktrees.md) | Mimir owns worktrees | D-002 | Accepted |
| [003](ADR-003-public-rename-before-launch.md) | Public rename before launch | D-003 | Accepted, name open |
| [004](ADR-004-durability-layer.md) | Mimir is the durability layer (subscribe, then snapshot) | D-004 | Accepted |
| [005](ADR-005-runtime-state-from-agent-status.md) | Runtime state comes only from `agent_status` | D-005 | Accepted |
| [006](ADR-006-apache-2-and-free.md) | Apache-2.0 and free | D-006 | Accepted |
| [007](ADR-007-newer-spec-wins.md) | The newer spec wins | D-007 | Accepted |
| [008](ADR-008-two-separate-repos.md) | Separate repositories per product | D-008 | Accepted |
| [009](ADR-009-provider-neutral-director.md) | Provider neutral director (Sindri) | D-009 | Accepted |
| [010](ADR-010-durable-event-storage.md) | Durable event storage design | Phase 0 ask | Accepted, implemented |
| [011](ADR-011-task-state-machine.md) | Task state machine | Phase 0 ask | Accepted, implemented in core |
| [012](ADR-012-auth-model.md) | Auth model | Phase 0 ask | Accepted, server enforcement in progress |
| [013](ADR-013-git-isolation.md) | Git isolation | Phase 0 ask | Accepted, implementation in progress |
| [014](ADR-014-exact-allowlist-classifier.md) | The exact allowlist is the command gate; the heuristic is defence in depth | T11 fix round 4 ruling | Accepted, implemented in core |

D-010..D-012 (Brokkr, the fourth product) are recorded in the Sindri and Brokkr repositories, not here, except where they touch Mimir's `verifying` step (see ADR-011).
