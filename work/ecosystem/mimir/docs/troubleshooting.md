# Troubleshooting

Run `mimir doctor` first; it names most problems. `mimir doctor --json` is the same data for scripts.

| Symptom | Cause and fix |
|---|---|
| `FAIL node` | Node is older than 25. Install Node 25 (`.nvmrc`) and reopen the shell. |
| `FAIL git` | git older than 2.38 (worktree features need it). Upgrade git. |
| `FAIL herdr` | `herdr` is not on `PATH` or older than 0.9.0. Install it and rerun doctor. |
| `WARN herdr-socket ... not running` | No `mimir` HerdR session. Start one in a separate terminal: `herdr --session mimir server`. Doctor only checks the socket file exists; it does not connect. |
| `WARN gh/claude/codex` | Optional tools are missing. Only matters if you want those agents. |
| `data-dir` not writable | Check ownership and permissions of `MIMIR_DATA_DIR` (default `~/.mimir`). |
| `mimir: command not found` | `~/.local/bin` is not on `PATH`. Add it to your shell profile, or run `~/.mimir/app/bin/mimir`. |
| `install-local: Node 25 or newer is required` | The installer checks Node first. Upgrade Node. |
| `mimir start` prints `web app not found` | `apps/web/dist` is not built. Run `pnpm build`, or set `MIMIR_WEB_ROOT`. The API still works. |
| `mimir start` / `mimir demo` exit 3 | The server failed to start (see the lines above it: bad `MIMIR_PORT`, port in use, locked data dir, or `server not found`: run `pnpm build`). |
| `mimir demo` leaves a `mimir-demo-*` directory in the temp dir | The process was killed with SIGKILL. Ctrl C or SIGTERM cleans up; delete the directory by hand. |
| 401 from the API | Missing or wrong bearer token. Use `mimir token show`. The token is created by `mimir init` or on first server start. |
| 403 from the API | The `Host` or `Origin` header is not recognised. For a custom hostname or port set `MIMIR_PUBLIC_ORIGINS` (server) or `MIMIR_ALLOWED_ORIGINS` (third party web origins). |
| 422 `Idempotency-Key header is required` | Add an `Idempotency-Key` header to every POST. |
| 404 on a `/v1/...` route | The path is not served; check [api](api.md). Outside `/v1`, a 404 means the web app is not being served (see `web app not found`). |
| `Refusing to bind to non-loopback host` | Remote bind needs `MIMIR_ALLOW_REMOTE=1` plus `MIMIR_TLS_CERT` and `MIMIR_TLS_KEY`. |
| `mimir export` says `no event store` | Nothing has written to `<data dir>/mimir.db` yet. Check `MIMIR_DATA_DIR`. |
| `mimir export` says file exists (exit 2) | Pass `--force` or choose another `--out`. |
| Event store lock error when starting a second server | One writer per data dir. Stop the other server or use another `MIMIR_DATA_DIR`. |
| `@mimir/git` tests time out under load | The git worktree tests are timing sensitive; rerun `pnpm --filter @mimir/git test` on an idle machine. |

Logs are structured JSON (pino) on stdout; set `MIMIR_LOG_LEVEL=debug` for more. Authorization
headers are redacted.
