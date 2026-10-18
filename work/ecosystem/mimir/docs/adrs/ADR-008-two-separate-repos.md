# ADR-008: Separate repositories per product

Status: Accepted (2026-10-14). Source: D-008 (plus the Brokkr addendum).

## Context
The user asked for Mimir and Sindri to be two independent projects. The dependency rule is: Sindri requires Mimir, Mimir never requires Sindri, nobody but Mimir touches HerdR. Mimir must not know what a software factory is.

## Decision
`mimir/`, `sindri/` (and `brokkr/`) are independent git repositories with their own history, tooling and releases. No shared workspace and no path imports. Sindri consumes Mimir only through the published `@mimir/sdk` and `@mimir/protocol`; while everything is local these are `pnpm pack` tarballs. The HerdR adapter is a package inside `mimir/`.

## Consequences
* The `@mimir/protocol` and `@mimir/sdk` contract is versioned and must be backwards compatible within a minor version.
* Mimir contains no ticket, spec or harness concepts.
* Local git only: no remotes, no pushes, no GitHub issues, which is why `docs/issues/` holds local issue files.
