# Security policy

Sindri is local first software with no hosted service. There is no public disclosure channel yet because the project is developed locally.

## Reporting

Open a file under `docs/issues/` marked `security` (for example `docs/issues/security-<short-name>.md` with `Labels: security` at the top). Include the version (`CHANGELOG.md`), reproduction steps and impact. Please keep exploit details out of any public place until a fix exists.

## Scope

In scope: authentication and the local server, secret handling, prompt injection handling, repository file reading (symlinks, secret files), connector credential handling, and data export or deletion.

Out of scope: the content of third party providers or trackers, and attacks that require an already compromised local user account.

## Supported versions

Only the latest 0.1.x. See `docs/security.md` for the threat model and its known gaps.
