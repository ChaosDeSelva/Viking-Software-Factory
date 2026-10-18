# ADR-009: MPL-2.0 dependencies accepted for test and build only

Status: Accepted (2026-10-14).

## Context

Sindri is Apache-2.0. Copyleft and source available dependencies are avoided. The browser accessibility tests use `axe-core` and `@axe-core/playwright` (MPL-2.0). The web build toolchain resolves `lightningcss` (MPL-2.0) as a transitive build time package.

## Decision

MPL-2.0 is file level copyleft. We accept it for development, test and build time tools that are not distributed in a Sindri release and are not modified by us. No MPL-2.0 package may be a runtime `dependency` of a shipped package. See `docs/licenses.md`.

## Consequences

* A runtime dependency under MPL-2.0 or any stronger copyleft needs a new ADR.
* Releases ship built output only, not these tools.
