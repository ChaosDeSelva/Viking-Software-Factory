# HerdR socket API diff: 0.7.4 (protocol 16) → 0.9.4 (protocol 22)

Generated 2026-10-14 from `herdr api schema --json` on both versions. Raw
schemas sit beside this file. `schema_version` stayed at 1.

## Breaking for the Mimir adapter

* `agent.send` **removed**. Replacements: `agent.prompt` (text to an agent's
  composer) and `agent.send_keys` (keys to an agent). Adapter `sendInput` must
  target 0.9.x methods and treat 0.7.x as unsupported.
* `pane.graphics.*` removed (irrelevant to Mimir).

## Added that Mimir will use

* `agent.wait` (socket level wait for `idle|working|blocked|done|unknown`).
* `agent.prompt`, `agent.send_keys`.
* `integration.list` with `IntegrationState` `not_installed|current|outdated`:
  lets onboarding show which harness hooks are installed.
* `agent.view.set` / `agent.view.clear` with sort and filter fields
  (`status`, `seen`, `state_change_seq`, `attention`); `state_change_seq` is a
  per agent monotonic counter worth recording as `sourceEventId` material.
* Filter expression methods `all|any|not|eq|in|exists` (used by views).
* `workspace.move_block`, `workspace_reordered` event.
* `command.invoke`, `pane.input.set`, `pane.clear`, `pane.scroll`,
  `pane.selection.read`, `pane.link.*`, `pane.copy_*`, `pane.edit_scrollback`.
* `server.ssh_agent.register`, `client_shell.surface.set`.

## Unchanged

* `AgentStatus` enum: `idle, working, blocked, done, unknown`.
* Event kinds, except the added `workspace_reordered`.
* `events.subscribe` still has no cursor or replay.
* `session.snapshot`, `agent.start`, `agent.read`, `pane.send_keys`,
  `pane.run`, `pane.process_info`, `pane.close`, `notification.show`.

## Status line after upgrade

`herdr status` now reports `endpoint_protocol_generation: 1` alongside
`private_protocol: 22`. Capability negotiation keys on the endpoint
generation, not the private protocol number.

## Live handoff result

`herdr update --handoff` from 0.7.4 to 0.9.4 kept all 11 running Claude
sessions alive. Every pane received a new `terminal_id`, so bindings keyed on
`terminal_id` do **not** survive a HerdR server replacement. Reconcile must
re bind by `pane_id` + `cwd` + agent session id after a server restart.
