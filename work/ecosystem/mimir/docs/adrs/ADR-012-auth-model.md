# ADR-012: Auth model

Status: Accepted as a design (2026-10-14). Enforcement is task T6 (in progress, branch task/T6, not on main). Today `apps/server/src/index.ts` serves only `GET /v1/health` and `apps/server/src/config.ts` binds `127.0.0.1` only.

## Context
Mimir controls agents that can run shell commands and edit code. HerdR itself has no authentication; its socket is protected only by file permissions. Any local process, and any web page in the user's browser, can reach `127.0.0.1`.

## Decision
* Loopback bind by default (`resolveListenOptions` in `apps/server/src/config.ts`, `MIMIR_HOST` default `127.0.0.1`). Non loopback is refused unless `MIMIR_ALLOW_REMOTE=1` and TLS cert and key are set (planned, T6).
* A local bearer token: `MIMIR_AUTH_TOKEN` or generated on first start into a file under the data directory with mode 0600 (planned, T6; `mimir init` and `mimir token show` in the later CLI task).
* Every `/v1/*` route except `/v1/health` requires `Authorization: Bearer <token>` with constant time comparison; failures return 401 using `ApiErrorBody`.
* CSRF and DNS rebinding defence: reject requests whose `Origin` is not the server's own origin or in `MIMIR_ALLOWED_ORIGINS` (planned, T6).
* Headers named `authorization` are redacted from logs (planned, T6).
* Humans approve privileged actions; agents and system actors cannot approve, and nobody can approve their own request (`packages/core/src/policy/approvals.ts`, implemented).
* Mimir does not expose HerdR's socket; the adapter is the only caller.

## Consequences
* Until T6 lands, the server exposes only `/v1/health`.
* The token file is a local privilege boundary: anything that can read it can drive Mimir (see threat model).
* Multi user and remote access are out of scope for 0.x.
