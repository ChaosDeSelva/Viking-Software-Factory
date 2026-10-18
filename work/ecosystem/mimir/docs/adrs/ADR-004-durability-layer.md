# ADR-004: Mimir is the durability layer (subscribe, then snapshot)

Status: Accepted (2026-10-14). Source: D-004. Evidence: `spikes/herdr-spike/FINDINGS.md` sections (b) and (c). Adapter implementation: task T8 (in progress).

## Context
HerdR `events.subscribe` has no cursor and no replay. Ordering holds only within one subscription entry. No event carries a sequence number; `PaneInfo.revision` and `AgentInfo.state_change_seq` appear only on reads. A slow reader gets `events_lost` and the connection closes, but the spike observed a stalled reader getting a silent EOF with no `events_lost` line (server write timeout of 5 s). HerdR is also replaced or restarted without notice, and `terminal_id` changes on any session stop and start.

## Decision
Mimir owns durability.
1. Bootstrap order is `events.subscribe` first, then `session.snapshot`, then apply the snapshot and replay buffered events on top, using pane `revision` to drop stale ones.
2. Mimir assigns its own `sequence` per stream and its own global cursor (ADR-010).
3. **Any EOF on a subscription connection is treated as possible event loss**, whether or not `events_lost` arrived: emit `runtime.gap`, resubscribe, re snapshot, diff bound sessions, and emit synthesized transitions tagged `provenance: derived`.
4. Sessions are bound by `pane_id` + `cwd` + agent session id, never `terminal_id` alone.

## Consequences
* The UI and SDK replay from Mimir's store, never from HerdR.
* Per pane `pane.agent_status_changed` subscriptions must be added when each pane appears (the subscription requires `pane_id`).
* A synthesized event is never presented as observed.
