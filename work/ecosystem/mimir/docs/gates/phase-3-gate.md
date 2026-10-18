# Phase 3 gate (G3): fresh install walkthrough

Question this page answers: can someone install Mimir from the release tarball and run it from
the docs, without the source tree? Walkthrough run 2026-10-14 on macOS arm64 (Darwin 24.6.0),
Node 25.9.0, pnpm 12.11.2, git 2.39.5, HerdR 0.9.4, from branch `task/T15d` (main f4b12a6, which includes T12fix, plus the
T15d commits). Outputs below are pasted from that run; only the long scratch paths are kept as
they were. The walkthrough used an empty `HOME` (`x/home`) and `MIMIR_DATA_DIR` inside it, so
nothing under the real `~/.mimir` was read or written.

Not claimed: an independent developer following only the docs (the G3 acceptance in M17), Linux,
Windows, a real HerdR session with a real agent. This was run by the implementer.

## 1. Build the release

```sh
pnpm release:local
```

Last lines of the real run:

```
licenses: 291 packages, 7 dev-only MPL-2.0, 0 violations
sbom: 331 components -> dist/sbom.cdx.json
tarball: .../dist/mimir-0.1.0-macos-arm64.tar.gz
packages: .../dist-packages
```

Produced `dist/mimir-0.1.0-macos-arm64.tar.gz` (54,696,052 bytes), `dist/sbom.cdx.json`,
`dist-packages/mimir-protocol-0.1.0.tgz` (35,870 bytes) and `dist-packages/mimir-sdk-0.1.0.tgz`
(17,339 bytes). An earlier run of this walkthrough found the tarball shipped `apps/server/test`
and `bench` (11 test files); `scripts/release-local.mjs` now strips them and
`scripts/release-local.test.mjs` ("ships no sources, tests, or secrets") passes.

## 2. Extract and inspect

```sh
tar -xzf dist/mimir-0.1.0-macos-arm64.tar.gz
ls mimir-0.1.0-macos-arm64 mimir-0.1.0-macos-arm64/app
tar -tzf dist/mimir-0.1.0-macos-arm64.tar.gz | grep -c -e axe-core -e lightningcss
tar -tzf dist/mimir-0.1.0-macos-arm64.tar.gz | grep -v node_modules | grep -c '\.test\.'
```

```
mimir-0.1.0-macos-arm64:
app  bin  CHANGELOG.md  docs  LICENSE  README.md  scripts  VERSION

mimir-0.1.0-macos-arm64/app:
cli  server  web
0
0
```

The tarball holds no development only MPL-2.0 packages (`axe-core`, `lightningcss`) and no test files.

## 3. mimir init and mimir doctor

```
$ mimir init
data dir: <scratch>/x/home/.mimir
token: <scratch>/x/home/.mimir/auth-token (created)
$ mimir doctor
OK   node          25.9.0 (>= 25)
OK   pnpm          12.11.2
OK   git           2.39.5 (>= 2.38.0)
OK   herdr         0.9.4 (>= 0.9.0)
WARN herdr-socket  session "mimir" not running (<scratch>/x/home/.config/herdr/sessions/mimir/herdr.sock absent)
OK   gh            gh version 2.102.0 (2026-09-30)
OK   claude        2.1.289 (Claude Code)
OK   codex         codex-cli 0.162.1
OK   data-dir      <scratch>/x/home/.mimir writable
exit=0
```

The warning is expected: no `herdr --session mimir server` was started for this walkthrough.
`mimir --help` lists `init`, `token`, `doctor`, `export`, `start` and `demo`.

## 4. mimir demo

```
$ MIMIR_PORT=0 mimir demo
mimir demo (fake runtime, temporary data; nothing is auto-approved)
url: http://127.0.0.1:50776
mission: msn_01M4XX8J0X3N98EBN4QG59RJBQ
token file: <scratch>/x/tmp/mimir-demo-QfaOWQ/data/auth-token
paste the token into the web app; decide any approvals yourself. Ctrl-C to stop and clean up.
```

Requests made against that URL while it ran, with the token from the printed file:

```
GET /                           200 text/html; charset=utf-8 (the built web app, no token)
GET /v1/missions (no token)     401
mission: active, crews 1, tasks 3
t+5s    Write the greeting  verifying
t+15s   Write the greeting  completed
        Count the files     blocked approval_required
        Print the date      pending
        approval: shell.unclassified pending
```

The first task (`echo`, on the default allowlist) ran to completion on the fake runtime. The second
(`ls | wc -l`, a pipeline) is `shell.unclassified`, so it waits for a human in the approval inbox
and nothing was approved on anyone's behalf. After SIGTERM the demo exited 0 and the temporary
directory (`mimir-demo-*`) was gone.

The demo project's `testCommand` is `["npm", "test"]`. An earlier version used
`["node", "-e", "process.exit(0)"]`; after the T12fix merge the server refuses a `testCommand`
that is not on the project's allowlist (422 `test_command_not_allowlisted`), which this
walkthrough caught.

## 5. mimir start from the tarball

```
$ MIMIR_PORT=0 mimir start
mimir server listening on http://127.0.0.1:51059
auth token: <scratch>/x/home/.mimir/auth-token
runtime: fake  data: <scratch>/x/home/.mimir  tick: 1000ms
GET / 200 text/html; charset=utf-8
GET /missions/x 200                   (SPA fallback)
GET /assets/nope.js 404               (missing asset is a real 404)
GET /v1/missions no token 401
{"missions":[]} <- /v1/missions with token 200
start exit=0                          (after SIGTERM)
```

## Findings

* Works from the extracted tarball with `node` only; no `pnpm install` on the target.
* `mimir doctor` still checks only that the HerdR socket file exists; it does not connect or read
  `integration.list` (docs/limits.md).
* The demo's later tasks wait for approval by design; approve them in the web app to see the
  mission finish.
* `scripts/install-local.sh` was not re run in this pass; it is covered by
  `scripts/release-local.test.mjs` (`pnpm test:release`).

## How to repeat

```sh
pnpm release:local
mkdir -p /tmp/g3/home && tar -xzf dist/mimir-0.1.0-macos-arm64.tar.gz -C /tmp/g3
export HOME=/tmp/g3/home MIMIR_DATA_DIR=/tmp/g3/home/.mimir
/tmp/g3/mimir-0.1.0-macos-arm64/bin/mimir init
/tmp/g3/mimir-0.1.0-macos-arm64/bin/mimir doctor
/tmp/g3/mimir-0.1.0-macos-arm64/bin/mimir demo
```
