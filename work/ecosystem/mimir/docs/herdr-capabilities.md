# HerdR capability map (H01, corrected by T8)

Upstream: github.com/herdrdev/herdr, tag v0.9.4, Apache-2.0. Local: 0.9.4, protocol 22, endpoint generation 1.
Every method below exists in `docs/herdr/schema-0.9.4-protocol22.json`. "live" means exercised against a real 0.9.4 server, either in the Phase 0 spike (`spikes/herdr-spike/FINDINGS.md`) or by the opt in adapter live test (`packages/herdr-adapter/test/live.test.ts`). The wire facts these rows depend on are in [`herdr/wire-facts.md`](herdr/wire-facts.md).

Mimir uses a dedicated named session, `herdr --session mimir`, with the socket at `~/.config/herdr/sessions/mimir/herdr.sock`. It never uses the user's default session (`~/.config/herdr/herdr.sock`) unless configured to.

## Method map (as implemented in `@mimir/herdr-adapter`)

| RuntimeAdapter need | HerdR socket method(s) | Status | Notes |
|---|---|---|---|
| capabilities() | `ping`, `session.snapshot` | live | Version comes from `snapshot.version` (falls back to `ping.version`). `pause:false`, `multiHost:false`, `notify:false`. Agent kinds are the canonical `agent.start` kinds plus Mimir's `shell`. |
| health() | `ping` | live | Not ok when the socket is missing (ENOENT, `runtime_unavailable`) or the protocol is not 22. |
| createSession() | `workspace.create {cwd, env, label, focus:false}` → `pane.report_metadata {pane_id, source:"mimir", tokens:{mimir_session}}` (binding marker) → `pane.process_info` (stable bare shell) → `agent.start {name, kind, pane_id, args, timeout_ms}` (retry `agent_pane_busy`) → `agent.wait {target, until:["idle","blocked"], timeout_ms}` | live | `workspace.create` returns `root_pane.pane_id`/`terminal_id` synchronously. `agent.start` returns `launch_pending:true`, so readiness comes from `agent.wait`. `name` must match `^[a-z][a-z0-9_-]{0,31}$`, so the adapter uses the lowercased session id. `tab.create` is not needed. |
| createSession() for `agentKind:"shell"` | `pane.send_text` + `pane.send_keys ["enter"]` | live | There is no shell kind in `agent.start`. The command gets `; echo MIMIR_DONE:<sessionId>:<nonce>:$?` appended. This is the only place terminal text sets state (see wire facts §5). |
| listSessions()/getSession() | `session.snapshot` joined with the binding store | live | Unbound panes are ignored. |
| sendInput() text | `agent.prompt {target, text}` | spike: error path only | Fails with `agent_not_ready` unless the agent is idle; mapped to a retryable `conflict`. `agent.send` does not exist in 0.9.x. Shell kind uses `pane.send_text`. |
| sendInput() keys | `agent.send_keys {target, keys}` / `pane.send_keys {pane_id, keys}` | live (`pane.send_keys`) | Keys are combos such as `"ctrl+c"`, `"enter"`, `"esc"`. If the agent has released the pane, the adapter falls back to `pane.send_keys`. `pane run` is a CLI command, not a socket method. |
| subscribe() | `events.subscribe` (one lifecycle connection, plus one connection per bound pane) | live | Lifecycle types are subscribed by dotted name and pushed with underscore names. `pane.agent_status_changed` needs a `pane_id` per entry. Shell panes also get `pane.output_matched` for the sentinel. No cursor or replay. Any EOF triggers gap, resubscribe and re snapshot. |
| status dedupe | `agent.get {target}` | live | Events carry no sequence. The adapter reads `agent_status` + `state_change_seq` together after each status event. |
| requestStop(soft) | `pane.send_keys ["ctrl+c"]`, then `pane.process_info` polling | live | `agent.wait idle` is not proof of exit. Interactive claude needs a second Ctrl C, which the adapter sends halfway through the poll. If the stop is never confirmed, it throws a retryable `conflict`. |
| requestStop(force) | `pane.close {pane_id}` | live | Closing the last pane closes the workspace, and `workspace_closed` can arrive before `pane_closed`. Destructive: approval gated in Mimir. |
| reconcile() | `session.snapshot`, `pane.process_info` per bound session, `pane.read` (shell sentinel) | live | `pane_not_found` confirms the session is lost. A changed `terminal_id` means HerdR restarted and the process was not restored. |
| terminal read | `pane.read {pane_id, source, lines}` | live | Use this after an agent releases the pane, because `agent.read` returns `agent_not_found` then. |
| notify | `notification.show` | schema only | Not used by the adapter (`notify:false`). |
| pause/resume | none | unavailable | `capability_unavailable` |
| listHosts() | none | unavailable | `herdr machine` is CLI side in 0.9.x. |
| worktrees | `worktree.*` | present, NOT USED (ADR-002) | Mimir owns worktrees. |

## Subscription types (request side) vs pushed event names

| Subscribe with `{type: ...}` | Extra required fields | Pushed `event` | `data.type` |
|---|---|---|---|
| `workspace.created`, `workspace.updated`, `workspace.metadata_updated`, `workspace.renamed`, `workspace.moved`, `workspace.reordered`, `workspace.closed`, `workspace.focused` | none | `workspace_created`, … (underscore) | same as `event` |
| `worktree.created`, `worktree.opened`, `worktree.removed` | none | underscore | same |
| `tab.created`, `tab.closed`, `tab.focused`, `tab.renamed`, `tab.moved` | none | underscore | same |
| `pane.created`, `pane.closed`, `pane.updated`, `pane.focused`, `pane.moved`, `pane.exited`, `pane.agent_detected` | none | underscore | same |
| `layout.updated` | none | `layout_updated` | same |
| `pane.agent_status_changed` | `pane_id` (optional `agent_status` filter) | `pane.agent_status_changed` (dotted) | absent |
| `pane.output_matched` | `pane_id`, `source`, `match {type: substring\|regex, value}` (optional `lines`, `strip_ansi`) | `pane.output_matched` | absent |
| `pane.scroll_changed` | `pane_id` | `pane.scroll_changed` | absent |

There is no `pane.output_changed` subscription and no all panes status subscription. The H01 list of "event kinds" mixed up wire names and subscription types.

## Agent status

`idle`, `working`, `blocked`, `done`, `unknown`. Mimir maps them to `idle`, `running`, `blocked`, `completed` and `unknown`. A release (`pane_agent_detected {released:true, final_status}`) maps to `completed` when the final status is idle or done, and to `failed` otherwise.

## Known limits

* No authentication on the socket; file permissions only.
* One request per connection, about 100 ms each on an idle server. Batch reads and avoid chatty polling.
* `events.subscribe` has no cursor or replay. Ordering holds only within one subscription entry. A stalled reader gets a silent EOF after a 5 s write timeout. The documented `events_lost` line arrives only when the reader is slow but still draining.
* Events carry no sequence number. Use `PaneInfo.revision` and `AgentInfo.state_change_seq`/`completion_seq` (reads only).
* `terminal_id` changes on every server stop/start (and on live handoff). Panes keep `pane_id`, `workspace_id` and `cwd`. Agent processes are not restored without an agent session reference.
* A fresh pane's zsh startup can take several seconds, alternating short bare shell windows with helper processes. Input typed during startup is lost (live, T8).
* Interactive `claude` in an untrusted folder blocks at Claude Code's folder trust dialog, which HerdR reports as `blocked`. Mimir surfaces this as `blocked:trust_prompt` and never accepts the dialog. `claude -p` did not prompt.
* Copilot status still comes from screen detection (0.6.7 changelog).

## Still open

* `agent.prompt` happy path, and soft stop of a *working* agent (both need an agent past the trust dialog).
* Whether a pane with a reported `agent_session` gets resumed after restart.
* Reproducing the documented `events_lost` error line.
