# HerdR 0.9.4 wire facts (protocol 22)

These are the facts `@mimir/herdr-adapter` is built on. Each one was observed against a live 0.9.4 server, either in the Phase 0 spike (`spikes/herdr-spike/FINDINGS.md`) or by the adapter's opt in live test (`packages/herdr-adapter/test/live.test.ts`, run with `MIMIR_LIVE_HERDR=1` against the session `mimir-adapter-test`).

Fixture paths below are relative to `packages/herdr-adapter/test/fixtures/`. Each line of a `.ndjson` recording is `{t_ms, kind, sub?, method?, params?, result?, error?, msg?}`, and pushed envelopes sit inside `msg: {event, data}`. `t_ms` is milliseconds since the experiment started.

## 1. One request per connection

Each request opens a new connection, sends one line `{id, method, params}`, reads one response line, and the server closes the connection. A subscription is a connection that stays open. It sends an ack `{type:"subscription_started"}` and then pushes lines. A request takes about 100 ms on an idle server.

Evidence: `src/api/server.rs` `handle_connection_with_stop`. In the spike, a multiplexed client got `connection_closed` on its second request. Every `request`/`response` pair in `lifecycle-events.ndjson` is one connection (for example `t_ms` 340 → 446 for `workspace.create`).

## 2. Subscriptions use mixed naming; status needs a `pane_id` per entry

Lifecycle kinds are subscribed by dotted type (`pane.created`, …). They are pushed with an underscore `event` name and a matching `data.type`. `pane.agent_status_changed` is pushed with its dotted name and no `data.type`. It requires `pane_id`: without one the server answers `invalid_request: invalid request: missing field 'pane_id'`, and an unknown pane fails the whole subscribe call with `pane_not_found`. There is no all panes status subscription and no `pane.output_changed`. Output is read with `pane.read`, or watched with `pane.output_matched {pane_id, source, match}`, which matches line by line and fires again only after the text stopped matching (`src/api/subscriptions.rs`).

Evidence: `lifecycle-events.ndjson`, where the `subscribe` records show the lifecycle spec list and `[{type:"pane.agent_status_changed", pane_id:"w5:p1"}]`, the `event` at 544 is `pane_created` with `data.type`, and the `event` at 6900 is `pane.agent_status_changed` without `data.type`.

## 3. No per event sequence

Envelopes have only `event` and `data`. `PaneInfo.revision` comes on `pane_created`/`pane_updated`. `AgentInfo.state_change_seq` and `completion_seq` come only on reads (`agent.get`, `agent.wait`, `agent.list`, `session.snapshot.agents`). The adapter reads `agent.get` after each status event and uses the status and `state_change_seq` from that single read. It also reads `agent.get` right after each per pane status subscription acks: an unfiltered `pane.agent_status_changed` subscription sends no initial event (upstream `subscriptions.rs`), so without that read a change between `session.snapshot` and the ack would be lost. `sourceEventId` is `"<pane_id>:<state_change_seq>"`, falling back to `"<pane_id>:<observedAt>:<status>"` when the read fails. Pairing the event's own status with a later read would mislabel a late event.

Evidence: `lifecycle-events.ndjson` `agent.wait` responses (`state_change_seq` 7 for blocked, then idle). `restart-events.ndjson` `agent.wait` (`state_change_seq` 9).

## 4. Loss is signalled by EOF

A stalled reader gets a plain EOF after the 5 s `STREAM_WRITE_TIMEOUT`, with no `events_lost` line. The documented `events_lost` error line (it carries the subscribe id) appears only when the reader is slow but still draining. Any EOF therefore means: emit `runtime.gap`, resubscribe, re snapshot, and re emit the bound sessions.

Evidence: `events-lost-subscriber.ndjson` (an ack, then 146 `workspace_renamed` events, then the connection closed with no error line). `restart-events.ndjson` `sub_closed … reason:"eof"` on session stop.

## 5. createSession

`workspace.create {cwd, env, label}` returns `root_pane.pane_id` and `terminal_id` synchronously. `agent.start {name, kind, pane_id, args, timeout_ms}` needs that pane to be at a bare shell; otherwise it fails with `agent_pane_busy` (retry, bounded to 10 × 500 ms). `kind` must be a real agent kind; there is no shell kind. `name` must match `^[a-z][a-z0-9_-]{0,31}$` (upstream `src/app/agents.rs`). The response carries `launch_pending:true`, so readiness is `agent.wait {target, until:["idle","blocked"], timeout_ms}`. For Mimir's `agentKind:"shell"` the adapter types the command with `pane.send_text` as `<command>; __mimir_rc=$?` and presses `pane.send_keys ["enter"]`. The command line carries no sentinel and no nonce (audit H4: anything typed sits in scrollback and shell history, where the running command, or any pane via `pane.read`, could read it). The adapter then polls `pane.process_info` until the shell has been the sole foreground process for `shellStableMs`; only then does it mint `<nonce>` (16 random hex characters, stored in the binding) and type one final line, ` echo MIMIR_DONE:<sessionId>:<nonce>:$__mimir_rc` (leading space: shells with `ignorespace`/`HIST_IGNORE_SPACE` keep it out of history). The sentinel is matched by a line anchored regex, `^MIMIR_DONE:<id>:<nonce>:(\d+)\s*$`, so the echoed command line (which contains `$__mimir_rc`, not digits) never matches, and it is accepted only while `pane.process_info` again shows a bare shell. `parseSentinel` never accepts a line without the session's nonce.

**Exception to the rule "terminal text never sets state" (brief T8 fact 5).** The shell kind sentinel is the only place where terminal text sets session state. It applies to `agentKind:"shell"` only, which Mimir uses for tests and demos. Agent kinds take state only from `agent_status`.

**Residual risk (audit H4).** The nonce does not exist until the command's foreground process has exited, so the command cannot learn it while it runs. Remaining paths: (a) a process the command left running in the background (or any other same user process) can poll `pane.read` on the HerdR socket and race the real `echo` with a forged line in the few milliseconds between typing and printing; completion still requires a bare shell, so the forged exit code is the only gain, and terminal states are sticky, so whichever valid line is seen first wins. (b) After sealing, the nonce is in the bindings file under `MIMIR_DATA_DIR` (0700) and in the pane scrollback; by then the session is finished. (c) A command that reads stdin after the shell looked bare for `shellStableMs` could consume the typed final line; the watcher then reports `unknown` (`no_sentinel`) after `sentinelReadAttempts`, never `completed`.

Added by the T8 live run: a fresh pane's zsh startup takes about 2.5 s and alternates short bare shell windows (about 150 to 400 ms) with helper processes (`path_helper`, `grep`, `tail`, `printf`, `bash`, zsh subshells). The foreground process group stays the shell's own while those children run. Text typed during startup was lost. "Bare" therefore means the shell is the only foreground process, and the adapter waits until that has held for 750 ms.

Evidence: `lifecycle-events.ndjson` `agent.start` error `agent_pane_busy` at 2156, then success at 3158 with `launch_pending:true`. The live test log ("process before stop … [\"sleep\"]") and the T8 report probe table.

## 6. End of a `claude -p` run

The run ends with `pane_agent_detected {released:true, final_status}` followed by `pane.agent_status_changed {agent_status:"unknown"}`. The pane and shell live on, and there is no `pane_exited`. After release, `agent.read` and `agent.get` return `agent_not_found`, so read output with `pane.read`. The adapter maps release to `completed` when `final_status` is idle or done, and to `failed` otherwise. It ignores the trailing `unknown`. The `pane_updated` just before the release carries `agent_session` (stored as `agentSessionId`).

Evidence: `lifecycle-events.ndjson` at 11745 (`pane_agent_detected … released:true, final_status:"idle"`), 11985 (`unknown`), and 14686/14791 (`agent_not_found`). The live test: `released:idle` → `completed`, and `readTerminal` contains PONG.

## 7. Stop

Soft stop is `pane.send_keys ["ctrl+c"]`, then polling `pane.process_info` until the shell is the only foreground process. `agent.wait idle` returned while claude was still alive, showing "Press Ctrl C again to exit". In zsh, Ctrl C on `sleep 30; echo …` abandons the rest of the list, so no sentinel is printed. Force stop is `pane.close`. Closing the last pane closes the workspace, and `workspace_closed` may arrive before `pane_closed`. A later `pane.process_info` returns `pane_not_found`.

Evidence: `lifecycle-events.ndjson` at 21650/21754 (wait returned idle) and 21962 (`claude.exe` still in the foreground), 22554 (`workspace_closed` before `pane_closed`), and 24593 (`pane_not_found`). The live soft stop and force stop tests.

## 8. Restart

On a session stop the socket file disappears (connect `ENOENT`), and open subscriptions get a plain EOF. After the restart, panes keep `pane_id`, `workspace_id` and `cwd` but get new `terminal_id`s, and they emit `pane_updated` (revision 1), not `pane_created`. The agent process is not restored without an agent session reference, and shell commands are never restored. Restored shells run their startup hooks again, so foreground activity right after a restart is not the session's command. Bind on `pane_id` + `cwd` + the `MIMIR_SESSION_ID` env marker + the agent session id; store `terminal_id` for display and restart detection only.

**Pane ids are reused (T8 fix round 1).** Upstream allocates workspace ids from a process global counter, which a restart resets to max(restored ids)+1 (`src/workspace.rs` `generate_workspace_id`, `reserve_workspace_ids`). So the next `workspace.create` hands out a `wN:p1` again in two cases: when the highest numbered workspace was closed before the restart, and after `herdr session delete` plus recreate (ids start again at `w1`). A binding is therefore a pane only when it passes `paneMatchesBinding`, which trusts only what HerdR itself observes:
1. The pane is still the launch terminal (`terminal_id`, assigned by HerdR): `match`.
2. Otherwise (a restart or a reused id), the realpath of `cwd` differs, or the agent session id differs when both sides know one: `mismatch`, and the binding is marked lost with reason `pane_reused`.
3. Otherwise, when the pane's `mimir_session` metadata token names another session: `conflict`. The session is reported `unknown` with `runtimeStatus:"marker_conflict"`; it is never marked lost, and the pane is not adopted (a finished session keeps its final state and its launch terminal).
4. Otherwise: `unverified` (restart handling below decides).

**Metadata tokens are not identity (audit H4).** Mimir still stamps `mimir_session=<sessionId>` with `pane.report_metadata {pane_id, source:"mimir", tokens}` right after `workspace.create` (live verified on 0.9.4; tokens live on the terminal and are not persisted, `persist/restore.rs`), but upstream `handle_pane_report_metadata` (`src/app/api/panes.rs`) accepts any `pane_id` and any `source` from any socket client, and every pane gets `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` in its environment. So any agent can write or erase another pane's token. A token can therefore only downgrade an unverifiable pane to `conflict`; it can neither prove a match nor cause `lost`.

HerdR 0.9.4 does not expose pane or process environment (`pane.process_info` returns `pid`, `name`, `argv`, `cmdline` and `cwd` per foreground process; `agent.get` returns agent fields), so the `MIMIR_SESSION_ID` env marker cannot be read back or verified. Unverified: whether a later HerdR exposes it.

When the check is a `mismatch`, the old binding is marked lost with reason `pane_reused`. That also happens when `createSession` receives a pane id another binding holds, and when `pane_created` arrives for a bound id with a different terminal (a restored pane emits `pane_updated`, never `pane_created`). Events route to the newest live binding for a pane id.

**Residual risk (audit H4).** The HerdR socket is unauthenticated: any process that can open it controls every pane (`pane.send_keys` into another agent's pane, including answering its permission dialog, `pane.read` of any scrollback, `pane.close`). Mimir cannot authenticate callers. The only hard boundary is running agents as a different OS user from the operator and from HerdR's socket owner.

Evidence: `restart-events.ndjson` (`sub_closed eof`, `connect ENOENT`, the post restart `pane_updated` events with revision 1 and new terminal ids, and the before/after table). The live restart test: the running `sleep 300` session was reported lost with reason `restart: process not restored`, and finished sessions were re bound with new terminal ids.

## 9. Claude Code folder trust dialog

Interactive `claude` in an untrusted directory blocks at the trust prompt, and HerdR reports `blocked`. The adapter reads `pane.read {source:"visible"}`, and when the text matches `/trust/i` it surfaces `session.state_changed` with `runtimeStatus:"blocked:trust_prompt"`. It never sends input to answer the dialog. `claude -p` one shots did not prompt, in the spike or in the T8 live run.

Evidence: `lifecycle-events.ndjson` at 21442 (`blocked`) and 21545 (the `pane.read` visible text with "Quick safety check … trust").

## 10. Input

Text goes through `agent.prompt {target, text, wait?}` only when the agent is idle; otherwise it fails with `agent_not_ready` (mapped to a retryable `conflict`). Keys go through `agent.send_keys {target, keys}` or `pane.send_keys {pane_id, keys}`, using combos such as `"ctrl+c"`, `"enter"` and `"esc"`. `agent.send` does not exist in 0.9.x.

Evidence: `agent_not_ready` in the spike (FINDINGS (a)). The schema `AgentPromptParams`, `AgentSendKeysParams` and `PaneSendKeysParams`.

## Known gaps (documented, not fixed)

* A `claude -p` release that happens entirely inside a gap leaves the session `unknown`. Re bootstrap sees no agent and status `unknown`; the trailing release event was missed. Policy is "unknown stays unknown", and reconcile does not guess `completed`.
* `createSession` stores the binding only after `workspace.create` returns, so a crash in between leaves an orphan workspace. Finished sessions' panes are not closed, and bindings are not pruned, so every gap re emits every bound session.
