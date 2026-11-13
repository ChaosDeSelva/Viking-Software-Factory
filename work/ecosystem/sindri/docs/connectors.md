# Connectors

Sindri can import Jira and Linear issues. Both connectors are read only and live in `packages/intake/src/connectors.ts`.

* Jira: issue and comment reads by `GET` only, limited to your configured base URL (for example `https://acme.atlassian.net`).
* Linear: GraphQL queries only. No mutation is ever sent.

Nothing is written back to the tracker: no comments, transitions or assignments.

## Credentials are handles, never values

Settings store the _name_ of a secret (`apiKeySecret`, `apiTokenSecret`), not the secret. The server rejects values that look like tokens (`sk-`, `lin_api_`, `ATATT`, `ghp_`) and unknown keys. Connectors are constructed with a `{ store, key }` handle and resolve the value at call time (`packages/intake/src/secrets.ts`); a literal credential throws.

Secret stores:

* macOS Keychain (default on macOS): `security find-generic-password -s sindri -a <key>`.
* Environment: `SINDRI_SECRET_STORE=env`. Key `jira.api-token` maps to `SINDRI_SECRET_JIRA_API_TOKEN`.
* An encrypted file store exists in the intake package for programmatic use.

## Setup

1. Create a scoped, read only token. Jira: an API token for an account that can only browse the needed projects. Linear: a personal API key from an account with read access only. Prefer a dedicated service account.
2. Store it: `security add-generic-password -s sindri -a jira.api-token -w` (macOS), or export `SINDRI_SECRET_JIRA_API_TOKEN` and start with `SINDRI_SECRET_STORE=env`.
3. In Settings, set the connector base URL and email (Jira) and the secret name, then turn local only off.
4. In Inbox, import by URL. Re importing a changed issue keeps the earlier snapshot and holds the update as pending.

## GitHub pull requests

A `https://github.com/<owner>/<repo>/pull/<n>` URL imports a pull request for review (`workKind: "pr_review"`). There is nothing to configure in Sindri: it runs the operator's own `gh` CLI, signed in with `gh auth login`, and stores no GitHub token. `GET /v1/github/status` reports whether `gh` is installed. Without a `projectId`, the registered project whose git remote names that repository is used. Set `settings.connectors.github.enabled` to false to turn it off. Unlike Jira and Linear, posting the finished review back to the pull request is possible, only after the operator's approval. See "PR reviews" in [api.md](api.md#pr-reviews).

## Local only mode

With `localOnly` on (the default), `POST /v1/intakes/import` returns 503 `local_only` and no connector request is made; pull request reviews cannot be imported, run or posted. Manual intake still works.

## What leaves your machine

Imports send the issue URL's request to your tracker with your token. Nothing else is sent to the tracker. For GitHub, `gh` reads the pull request and fetches its commits into Sindri's review mirror; a review is sent only when you post it. Provider egress is covered in `docs/security.md`.
