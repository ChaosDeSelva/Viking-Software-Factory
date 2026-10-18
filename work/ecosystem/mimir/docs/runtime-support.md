# Runtime support and fleet operation

Harness, terminal backend and execution host are separate choices. Inspect
`/v1/capabilities` for the configured runtime and `/v1/harnesses` for executable
availability on the controller. Installed is not authenticated or certified.

| Runtime | Configuration | Behavior | Validation |
| --- | --- | --- | --- |
| Direct CLI | `MIMIR_RUNTIME=cli` | Bounded watchdog processes | Local regression suite; Codex/Claude baseline |
| Managed tmux | `MIMIR_RUNTIME=tmux` | Headless CLI in a managed tmux session | Real tmux smoke |
| Interactive tmux | `MIMIR_RUNTIME=tmux-interactive` | Durable terminal identity, input and restart reconciliation | Real tmux fixture launch/input/restart/exit |
| Herdr | `MIMIR_RUNTIME=herdr` | Existing upstream Herdr adapter | Adapter contract suite |
| SSH | `MIMIR_RUNTIME=ssh` | Durable headless or interactive tmux remote jobs with source and patch transfer | Real exe.dev Codex execution, restart recovery, packet loss and blackhole acceptance |
| Fleet | `MIMIR_RUNTIME=fleet` | Capacity aware scheduling across explicit workers | Concurrent launch, restart, drain and ambiguous dispatch tests |
| Zellij / cmux / Orca | Matching runtime name | Native terminal adapters using attributed terminal backend helpers | Experimental; Zellij tested with attached PTY, cmux access restricted, Orca unverified |

Direct CLI, managed tmux and SSH support Codex, Claude, OpenCode, Gemini and Pi.
The last three are experimental. The interactive runtime has launch profiles for
Codex, Claude, OpenCode, Pi, Pi Signed, Grok, Kimi, Cursor, Gemini, Muse, Rovo,
OMP, AGY, Devin and Command Code. These are experimental launch contracts,
not proof of vendor authentication, identical permission semantics or complete
vendor hook compatibility. Their permission UI remains enabled.

Executable overrides use `MIMIR_<KIND>_BIN` (uppercase; hyphens become underscores).
For example `MIMIR_CLAUDE_BIN`, `MIMIR_PI_SIGNED_BIN` and `MIMIR_CURSOR_BIN`.
`MIMIR_TMUX_BIN` selects tmux. Install and authenticate agents on their execution
host. No account credentials are forwarded over SSH.

## Fleet configuration

Set `MIMIR_FLEET_CONFIG` to a JSON file and `MIMIR_RUNTIME=fleet`:

```json
{
  "version": 1,
  "workers": [
    {"id":"local-mac","runtime":"cli","capacity":2,"agentKinds":["codex","claude"]},
    {"id":"builder-one","runtime":"ssh","capacity":2,"host":"builder-one","root":"/home/operator/.mimir-remote"}
  ]
}
```

The factory launcher creates a local only fleet configuration on first use.
Use the existing file to add workers; restart the idle controller after editing.
Node identity, runtime, host and root are pinned. Changing a route requires a new
worker ID. An unresolved worker cannot be removed. `GET /v1/fleet` exposes
capacity, health, capabilities and session ownership. An authenticated,
idempotent `POST /v1/fleet/:id/drain` with `{"draining":true}` stops new placement
without cancelling existing work. Heimdall exposes these controls.

Placement is persisted before dispatch. Unavailable or ambiguous work reserves
its slot on the original host. Neither a controller restart nor a transport
failure automatically launches it on a different host. A stopped local CLI
controller cannot recover an old process as if it were a persistent terminal;
that missing session remains unknown for reconciliation.

## Interactive terminals

Interactive sessions use a fixed Node runner inside the terminal; task text is
stored in private structured launch data and passed as an argv element. The
shell is replaced with the runner, so input after agent exit cannot fall through
to a shell. Session state survives controller restarts. Exit evidence is written
atomically; quiet terminal output is never a completion signal. Terminal close
acknowledgement alone cannot certify that the process stopped.

Zellij requires its supported CLI plus jq. cmux requires its supported macOS app,
jq and an externally accessible socket policy. Do not automatically weaken the
operator's socket settings. Orca requires `MIMIR_ORCA_WORKTREE_ID`, identifying an
existing Orca worktree used as the terminal container. The runner uses Mimir's
actual task checkout. The adapter never removes Orca worktrees. Escape is not
supported by Orca's exposed API.

Automatic session scoped hooks cover Claude, Gemini, OpenCode, Pi/Pi-signed and
OMP, Devin and Command Code. Codex uses its turn end notification (not a full busy state source). Generated
settings and extensions live in runtime state, preserving project and global
configuration. Pi inner turn events never imply idle; OpenCode child session idle
cannot clear the latched active session. Hooks persist normalized observations,
not tool arguments, and never approve permissions or certify delivery.

Cursor and Muse use session transcript lifecycle adapters. Bindings require the exact
workspace and one new session, excluding pre launch logs and native child agent logs.
Malformed, partial, oversized or ambiguous evidence does not certify idle. New input
invalidates old idle evidence across controller restarts. These adapters are covered
by local fixtures; authenticated vendor acceptance remains pending.

Kimi and Grok now use an ACP v1 terminal bridge. It negotiates a session,
streams structured updates, rejects foreign session events, and requires an explicit
operator response to a permission request. Persistent permission grants are refused.
The bridge advertises no client filesystem or terminal tools. Unsupported protocol
or authentication negotiation fails visibly. These paths have protocol fixture coverage;
installed and authenticated vendor acceptance remains pending.

Rovo receives a private configuration copy with completion, error and permission hooks.
Existing permissions and hook commands are preserved. AGY receives a named entry in
its documented workspace hook file. The helper is inactive outside the owning launch
and binds to one conversation. Cleanup preserves operator edits and other sessions.
Neither hook implementation turns an agent notification into delivery approval.
Both remain experimental until tested against authenticated vendor installations.

The SSH worker flushes accepted requests and job state to disk before acknowledging
submission. A stale heartbeat is reported as unknown for both inspection and repeated
submission. Recovery never silently launches the same job again. Real exe.dev tests
cover input, cancellation, returned patches, client disconnect and VM restart.
Recovery tests use a deterministic agent. A separate authenticated Codex task generated
a greeting and tests on exe.dev; its returned patch also passed both tests locally.
Other vendor authentication and live compatibility remain unverified.

## Durable supervisors

`/v1/supervisors` registers parent/child supervisor identities. Each actor has a
SQLite backed inbox and fenced lease. Controls are observe, input and stop for
existing Mimir sessions; they flow through the same orchestrator policy checks.
Held parents stop child dispatch. Holds require a human readable reason.

Messages interrupted during dispatch become uncertain after lease takeover;
they are not resent. `/v1/supervisors/:id/resolve` requires explicit operator
outcome and evidence. Inspection exposes inbox state and ownership history.
Configure an existing mission through `POST /v1/supervisors/:id/policy`:

```json
{"missionId":"existing-mission-id","agentKind":"codex","enabled":true,"intervalMs":60000,"maxTurns":10}
```

Heimdall exposes this under Autonomous mission supervision. Disabled by default,
this uses the local Codex or Claude CLI authentication and may incur provider
charges. Decisions are strict JSON with at most four actions: observe, propose input,
soft stop or delegate to a registered child in the same mission. Scope is
rechecked after inference, and the lease is fenced before atomic action enqueue.
Model proposed input enters `awaiting_approval` and cannot dispatch until an
operator uses `/v1/supervisors/:id/authorize` with a decision and reason. This
prevents a model from answering terminal permission prompts automatically.
Operator or ancestor holds discard in flight proposals. Durable turn budgets
survive restart. Expired decisions are not automatically replayed. Used mission
and harness identities are immutable; a new scope needs a new supervisor.
This supervises existing approved missions; Sindri and Mimir still own planning,
launch authorization and verification. It cannot approve permissions or invent
new missions. One actual installed Codex decision smoke test passed; adversarial
scope, parent hold, lease takeover and budget cases use deterministic fixtures.

## SSH workers

Install Node and Git on the worker, build this project (or use a compatible
runtime release), and expose `mimir-remote-entrypoint` on its noninteractive PATH.
The packaged entrypoint is in `bin/`. For a source checkout:

```sh
#!/bin/sh
export MIMIR_REMOTE_ROOT="$HOME/.mimir-remote"
exec node /absolute/path/to/mimir/apps/server/dist/ssh-runtime/entrypoint.js
```

Set `MIMIR_SSH_HOST` to an SSH configuration alias and `MIMIR_SSH_ROOT` to the
actual normalized remote state directory when using the standalone SSH runtime.
Verify host keys first. On macOS use canonical `/private/...` temporary paths.
SSH uses strict host key checking, no agent forwarding, bounded structured stdin
requests and no automatic mutation retry or local fallback.

Transfer includes tracked regular source files only, bounded to 8 MiB / 10,000
files. Symlinks, submodules, dependencies and ignored assets are not transferred.
Provision dependencies on the worker. Returned patches must match the original
local baseline; human edits cause blocked reconciliation. Verification runs
through the normal local Mimir/Brokkr path. SSH workers are trusted machines,
not an OS sandbox.

For interactive remote work add `"backend":"tmux-interactive"` to an SSH fleet
worker. The host needs tmux and its chosen harness. The same durable terminal
runner and observational hooks execute remotely. Input uses a private durable
command receipt and the worker's single command loop; an ambiguous response
never resends input. The local integration test exercises the real entrypoint,
PTY input, controller restart and patch return. Real host network disconnect
acceptance is still pending. Native GUI backends are local host integrations.

## exe.dev preparation

The runtime archive includes `bin/mimir-exe-worker` with the same commands below.
An exe.dev VM can be an ordinary SSH worker. `node scripts/exe-worker.mjs plan
worker one` prints a bounded provisioning plan without network access. `list`
and `create <name> <stable-request-key>` use `EXE_TOKEN` and the documented
plain text HTTPS API. Creation receipts are durable; an ambiguous response must
be reconciled against provider inventory, never blindly resubmitted. The client
does not publish previews, install agents, copy credentials or change billing
plans. No remote VM was created during local development tests.

Sources: [exe.dev API](https://exe.dev/docs/https-api),
[VM creation flags](https://hub.exe.dev/docs/cli-new),
[Claude hooks](https://code.claude.com/docs/en/hooks),
[OpenCode CLI](https://opencode.ai/docs/cli/),
[Gemini headless](https://geminicli.com/docs/cli/headless/),
[Pi CLI integration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli-integration.md).

## Vendor contract references

* [AGY hooks](https://www.agy.dev/docs/hooks/)
* [Rovo configuration](https://support.atlassian.com/rovo/docs/manage-rovo-dev-cli-settings/)
* [Rovo event hooks](https://www.atlassian.com/blog/developers/streamline-rovo-dev-cli-with-event-hooks)

## October 15 acceptance update

Real SSH inspection passed through 20 percent random packet loss and a complete packet blackhole inside a disposable Linux network namespace. Restoring connectivity preserved the running job, and replay did not duplicate execution. The namespace and test SSH daemon were removed.

Zellij 0.45.1 passed live create, literal input, capture, incorrect owner refusal, control key, and close checks with a test PTY attached. Detached creation failed and remains experimental. The Mimir wrapper now scopes session names by installation and excludes exited sessions from liveness checks. Upstream backend source remains unchanged.

cmux is installed but its current control setting rejects external clients. That security setting was preserved. Orca and additional vendor authentication remain unavailable for live acceptance.

## Experimental release policy

Additional vendor accounts are not required for the initial open source release. Protocol fixtures and adapter logic ship with explicit experimental status; authenticated compatibility is not claimed. Contributors can report a minimal synthetic reproduction through the experimental adapter issue form. Include versions and redacted observed state, never credentials or private project content.

Unsupported lifecycle evidence remains unknown. Permission prompts stay under operator control. Fixture success does not certify vendor authentication, native application compatibility, or delivery.


## Skidbladnir AWS placement

A fleet worker may use the standalone local Skidbladnir API:

```json
{"version":1,"workers":[{"id":"aws-slot","capacity":1,"runtime":"skidbladnir","url":"http://127.0.0.1:4380","template":"general","minutes":15,"root":"/tmp/mimir","agentKinds":["codex"]}]}
```

The approved AMI must contain `mimir-remote-entrypoint`, Node, Git, and the selected harness with credentials configured on that image or worker. Mimir does not upload local credentials. Each job gets one owned disposable worker. The transport waits for SSM readiness, preserves final evidence locally before requesting termination, and uses the existing SSH runtime patch application and lifecycle events. Stable launch identities prevent duplicate allocation after uncertain responses or controller restart.

Inline mission envelopes are limited to 4500 bytes. Returned protocol evidence must fit AWS SSM output limits. Oversized or unconfirmed output fails visibly rather than being silently truncated or reported complete. Use the SSH runtime for larger repositories. The local acceptance test runs the real remote entrypoint with a synthetic agent and verifies returned changes. It does not establish authenticated agent compatibility for a custom AWS image.
