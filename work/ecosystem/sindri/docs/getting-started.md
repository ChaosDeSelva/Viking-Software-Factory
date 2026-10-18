# Getting started

Sindri plans the work (ticket, spec, plan, harnesses) and hands it to Mimir, which runs the agent crews. Install Mimir first, then Sindri, connect them, and try the demo. Everything runs on your machine; nothing is hosted.

## Prerequisites

* Node 25 or newer and git 2.38 or newer (`sindri doctor` checks both).
* pnpm, only when building from source.
* A model provider key is optional. Without one the Director uses the `null` provider and refuses to draft; the `fake` provider is local and needs no key. On macOS secrets live in the Keychain; elsewhere set `SINDRI_SECRET_STORE=env` and provide `SINDRI_SECRET_<NAME>` variables.

## 1. Install Mimir

Follow `mimir/docs/getting-started.md`: build it, then `mimir init` and `mimir doctor`. Real agent runs need HerdR 0.9.0 or newer on your `PATH`; Mimir's fake runtime (`MIMIR_RUNTIME=fake`, the default) needs nothing else and is what the Sindri acceptance run uses. Note Mimir's URL (default `http://127.0.0.1:7700`) and its token (`mimir token show`).

## 2. Install Sindri

From a release tarball (made by `pnpm release:local`, see `CONTRIBUTING.md`):

```sh
sh install-local.sh sindri-0.1.0-macos-arm64.tar.gz
# installs to ~/.local/share/sindri/<name> and writes the `sindri` shim to ~/.local/bin
```

`SINDRI_INSTALL_ROOT` and `SINDRI_BIN_DIR` change both locations. The tarball contains the CLI, its dependencies (including the native SQLite module, hence the os and arch in the name) and the built web app.

From source:

```sh
cd sindri
pnpm install
pnpm build
node apps/cli/dist/main.js --help   # use this wherever the guide says `sindri`
```

## 3. Initialise and check

```sh
sindri init       # data dir (default ~/.sindri, mode 0700), config.json and a 0600 auth token
sindri doctor     # node, git, data dir, config.json, provider key, Mimir reachability + protocol
sindri token show # the bearer token for the web UI and the API
```

`<dataDir>/config.json` holds `host`, `port` and optionally `allowedOrigins`. The server and `sindri start` read it; the environment variables below override each key. `sindri init` never overwrites an existing file.

`doctor` reports Mimir as a warning when no Mimir URL is configured or it is unreachable, and fails (exit 3) only when a Mimir answers but speaks a protocol Sindri does not support (see `compatibility.md`). It reports whether a provider key is present, never its value, and never prints credentials embedded in a URL. Every command takes `--json` (errors become `{ok:false,error,exitCode}`). Exit codes: 0 ok, 2 usage or configuration, 3 infrastructure.

## 4. Start Sindri and connect it to Mimir

```sh
sindri start
```

This serves the API and the web UI on one origin, by default `http://127.0.0.1:7800`, and prints an **approval pairing code** on its terminal. Open the URL and paste the token from `sindri token show`.

In Settings, set the Mimir URL and the name of the secret that holds Mimir's token (for example `mimir.token`, stored in the Keychain or as `SINDRI_SECRET_MIMIR_TOKEN`). `GET /v1/mimir/status` (the Settings panel) checks the connection. For `sindri doctor`, give the token as `MIMIR_AUTH_TOKEN` and the URL as `SINDRI_MIMIR_URL` or through Settings.

Approving a spec, a plan or a PR needs the pairing code as a second factor: the web UI asks for it once per session, and `sindri approve spec|plan|pr <id>` asks for it at a terminal. Never give the code to an agent. It changes every time the server starts.

## 5. Try the demo

```sh
sindri demo --with-failing-test
```

The demo writes a small full stack repository (a Node API, a React page and `node:test` tests) under a new temp directory (or `--dir <empty dir>`), commits it, creates a Sindri project for it, bootstraps the project index, imports a fixture ticket ("Add CSV export to the reports page") as a manual intake, and prints the inbox URL. `--with-failing-test` plants one test that fails once and then passes: with Mimir's fake runtime nobody edits code, so this one shot failure stands in for the repair a real agent would make.

Then, in the web UI:

1. Inbox: open the imported ticket.
2. Director: draft a spec from it, answer the blocking question, submit and approve it (pairing code).
3. Plans: propose a plan; Sindri picks harnesses (frontend, backend, QA, docs) and shows the dry run; submit and approve it.
4. Runs: start the execution. Mimir creates one crew per harness and role and runs the tasks; approvals Mimir asks for appear in Reviews.
5. Deliveries: the report, PR text and trace (ticket, spec version, plan version, mission, task events, artifacts).

Expect the quality gates to fail closed today: Mimir does not yet record a Brokkr verification report or the reviewer's `review.json`, so no task passes and PR requests are refused (see `limits.md` and `gates/g4-g7.md`).

## Environment

| Variable                                     | Meaning                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `SINDRI_DATA_DIR`                            | Data directory, default `~/.sindri`                                        |
| `SINDRI_HOST`, `SINDRI_PORT`                 | Listen address, default `127.0.0.1:7800` (overrides `config.json`)          |
| `SINDRI_ALLOWED_ORIGINS`                     | Comma separated CORS allowlist (overrides `config.json`)                    |
| `SINDRI_ALLOW_REMOTE`, `SINDRI_TLS_CERT/KEY` | Non loopback listening; requires TLS                                       |
| `SINDRI_SECRET_STORE=env`                    | Environment secrets instead of the Keychain                                |
| `SINDRI_SECRET_<KEY>`                        | A secret in the env store, for example `SINDRI_SECRET_MIMIR_TOKEN`         |
| `SINDRI_MIMIR_URL`, `MIMIR_AUTH_TOKEN`       | Used by `sindri doctor`                                                    |
| `SINDRI_WEB_DIST`                            | Override the built web directory                                           |
| `SINDRI_LOG_LEVEL`                           | Log level                                                                  |
