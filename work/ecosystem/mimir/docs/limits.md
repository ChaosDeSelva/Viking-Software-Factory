# Limits

What Mimir 0.1.0 does not do. This list is kept honest; if it is not here and not working, file it
in `docs/issues/`.

## Not working yet

* **Real agent runs are lightly tested.** Missions, crews, tasks, approvals, artifacts and PR
  requests run on the server and are tested end to end on the fake runtime. Runs through a real
  HerdR and the logged in Codex CLI have completed a real source repair through Mimir with
  independent Brokkr verification. This exercised the shell adapter invoking Codex, not every
  native agent mode or a full live multi crew factory.
* **Pull requests need `gh` and a remote.** `POST /v1/tasks/:id/pr` is approval gated and shells
  out to `gh`; it has never been run against a real remote.
* **Many commands ask for approval.** Classification is an exact allowlist (ADR-014): the project's
  `settings.allowedCommands` extends the built in default list. Anything else, including `sh -c`
  briefs, is `shell.unclassified` and waits for a human. Set `allowedCommands` on the project to
  reduce prompts for commands you trust.
* **A hard budget needs `onUnknown` when the runtime reports no usage.** No runtime reports usage
  yet, so `POST /v1/missions` refuses a hard limit without an explicit `onUnknown` (`allow` or
  `block`).
* **`mimir demo` and `start` default to the fake runtime**, which simulates agent sessions and does
  not execute the task command. Worktrees, policy, approvals and verification (the project's test
  command) are real.
* **Pause and resume of agent sessions are unavailable.** HerdR has no such operation, so the adapter
  reports `capability_unavailable`. Only stop is supported.
* **Single host.** Multi host is not supported; remote hosts are refused.
* **No measured usage without hooks.** Token and cost figures are `estimated` or `unavailable` unless
  the agent integration reports them. `mimir doctor` does not yet read per harness hook state
  (`integration.list`) and does not connect to the HerdR socket.
* **Mission pause is state only.** `POST /v1/missions/:id/pause` marks the mission paused; agent
  sessions are not paused.
* **No public package registry release.** Install from source or the local tarball. The project name
  is a working name (ADR-003).

## Platforms

* macOS arm64: used for all development.
* Linux: untested locally (CI workflow is defined but has not been run).
* Windows: untested and unsupported. HerdR's Unix socket and the shell tooling here assume POSIX.
* The release tarball is built for macos arm64 only (native SQLite module).

## Scale and safety

* One writer per data directory (lock file); run one server per data dir.
* Local only: loopback bind by default, no telemetry, no hosted service.
* Event ordering is per stream; there is no global order.
* Policy classification fails closed: unfamiliar shell constructs require approval, so expect extra
  prompts.
