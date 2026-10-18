# Getting started

This guide installs Mimir from a clone or from the local release tarball and gets you to a
healthy `mimir doctor`. It describes what exists on `main` today. Read [limits](limits.md) first
if you want to know what does not work yet.

What you can do today: build and run the server and web app on one origin (`mimir start`), try a
complete mission with no agents installed (`mimir demo`), create projects, missions, crews and tasks
over the API, decide approvals, read artifacts and the event log, and run the CLI (`init`,
`doctor`, `start`, `demo`, `token show`, `export`). Real agent runs need HerdR and an agent CLI;
see [limits](limits.md).

## Prerequisites

* Node 25 or newer (`.nvmrc`), pnpm 12.
* git 2.38 or newer.
* HerdR 0.9.0 or newer on your `PATH` (tested against 0.9.2, protocol 22).
* Optional: `gh`, `claude`, `codex`. `mimir doctor` reports them but does not require them.
* macOS arm64 is the only platform used so far. Linux is untested locally; Windows is untested.

## Option A: install from source

```sh
git clone <your local copy of the mimir repo> mimir
cd mimir
pnpm install
pnpm build
node apps/cli/dist/main.js --help
```

Run the CLI as `node apps/cli/dist/main.js <command>`, or link it: `pnpm --filter @mimir/cli exec
ln -s "$PWD/dist/main.js" ~/.local/bin/mimir`.

## Option B: install the local release tarball

```sh
pnpm release:local
bash scripts/install-local.sh dist/mimir-0.1.0-macos-arm64.tar.gz
```

`release:local` builds everything, writes `dist-packages/mimir-protocol-0.2.0.tgz` and
`dist-packages/mimir-sdk-0.2.0.tgz` (for other repos that consume the SDK), and produces
`dist/mimir-0.1.0-macos-arm64.tar.gz` containing the built CLI, server and web app. It runs with
plain `node`; no `pnpm install` is needed on the target.

`install-local.sh` installs under `~/.mimir/app` and writes a `mimir` shim to `~/.local/bin`. Add
that directory to your `PATH` if it is not there. Reinstalling replaces `~/.mimir/app` only; your
data (`~/.mimir/mimir.db`, `~/.mimir/auth-token`) is untouched. Override the locations with
`MIMIR_APP_DIR` and `MIMIR_BIN_DIR`.

## mimir init

```sh
mimir init
```

Creates the data directory (`MIMIR_DATA_DIR`, default `~/.mimir`), an auth token at
`<data>/auth-token` with mode 0600, and `<data>/config.json` (host, port, data dir, HerdR session).
Running it again keeps the existing token and config. Print the token with `mimir token show`
(or set `MIMIR_AUTH_TOKEN`, at least 16 characters, to override it).

## Connect HerdR

Mimir uses a dedicated HerdR session named `mimir` so it never touches your day to day session:

```sh
herdr --session mimir server
```

Leave that running in its own terminal. The socket is
`~/.config/herdr/sessions/mimir/herdr.sock`.

## mimir doctor

```sh
mimir doctor
```

Checks Node, pnpm, git, HerdR (version and the `mimir` session socket), the optional tools, and
that the data dir is writable. Doctor never starts HerdR and only checks that the socket file
exists; it does not connect. An absent socket is a warning ("not running"), not a failure.

Every command accepts `--json`. Exit codes: 0 ok, 2 bad config, 3 infrastructure problem (for
example a failed required check).

## Try the demo

```sh
mimir demo
```

Starts a server on the fake runtime in a throwaway data directory, creates a temporary git repo
whose project has a passing `testCommand`, a shell crew and a mission with three dependent tasks,
starts the mission, and prints:

```
url: http://127.0.0.1:<port>
mission: msn_...
token file: <temp dir>/data/auth-token
```

Open the URL, paste the token from that file, and watch the mission. The first task runs on its
own; the second is a shell pipeline, which the exact allowlist policy gates, so it waits in the
approval inbox until you decide. Nothing is approved for you. Ctrl C stops
the server and deletes the temporary directory. The demo never touches `~/.mimir`.

## Run the server and web app

```sh
mimir start
```

Starts the server (default `127.0.0.1:7700`) and serves the built web app from the same origin, so
open `http://127.0.0.1:7700/`. `start` reads `host` and `port` from `<data>/config.json`
(written by `mimir init`); `MIMIR_HOST` and `MIMIR_PORT` override them. The web app is looked up in
`apps/web/dist` (`app/web/dist` in the tarball); set `MIMIR_WEB_ROOT` to use another directory. If
it is not built, the server starts API only and prints a warning. Static files are public; every
`/v1/*` route except `GET /v1/health` still needs the bearer token, and the `Host` and `Origin`
checks apply to static files too.

`mimir start --runtime herdr` (or `MIMIR_RUNTIME=herdr`) runs agents through HerdR; the default is
the in memory fake runtime, and `none` runs without one. For development with hot reload use
`pnpm dev`: the server on 7700 and Vite on `127.0.0.1:5173`.

Try it:

```sh
TOKEN=$(mimir token show)
curl -s http://127.0.0.1:7700/v1/health
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7700/v1/capabilities
curl -s -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: demo-1" \
  -H "Content-Type: application/json" \
  -d '{"name":"demo","repoPath":"/absolute/path/to/a/git/repo"}' \
  http://127.0.0.1:7700/v1/projects
```

`GET /v1/health` needs no token; everything else does. Mutations need an `Idempotency-Key`.
See [api](api.md) for every route.

## Export events

```sh
mimir export --mission msn_... --out mission.json
```

Writes the mission's events with secrets redacted (mode 0600). It opens the store read only, so it
is safe while the server runs. It refuses to overwrite a file unless you pass `--force`.

## Next

[Concepts](concepts.md), [troubleshooting](troubleshooting.md), [limits](limits.md).
