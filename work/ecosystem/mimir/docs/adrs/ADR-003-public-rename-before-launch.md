# ADR-003: Public rename before launch

Status: Accepted (2026-10-14). The final name is not chosen. Source: D-003.

## Context
mimir.sh is a shipping agent observability product by Mimir Technologies, Inc. A public repo called Mimir would collide with it. The name "Sindri" (the factory) is flagged for the same checks.

## Decision
Keep "Mimir" and the `@mimir/*` scope internally until Phase 3. Choose the public name in Phase 0 and execute the rename before the repo goes public and before `@mimir/protocol` and `@mimir/sdk` are published.

## Name shortlist and offline checks
npm availability, checked 2026-10-14 with `npm view <name> name version`:

| Candidate | npm result | Meaning |
|---|---|---|
| `mimir` | exists, version 0.0.1 | taken |
| `mimir-control` | E404 | available |
| `huginn` | exists, version 0.1.5 | taken |
| `vedrfolnir` | E404 | available |

The npm result only covers an unscoped package name; a scoped name (for example `@<org>/protocol`) does not need the bare name. Checks not yet done and marked **TODO (manual)**:
* Trademark search for each candidate (USPTO and EUIPO). Not done, cannot be done offline.
* GitHub organization and repository name availability.
* Domain availability.
* "Sindri" gets the same checks (the chat log already flags collisions in games and software).

## Consequences
* Until the rename, docs and code say "Mimir".
* Rename scope: package scope `@mimir/*`, CLI binary `mimir`, the `~/.mimir` data directory, env vars `MIMIR_*`, ID prefixes in docs, the README and this ADR set. Phase 3 (epic M17) owns it.
* `mimir-control` and `vedrfolnir` are the only shortlisted names free on npm today; `vedrfolnir` is a Norse hawk name consistent with the Norse naming theme (Huginn is Odin's raven) but hard to spell.
