# Firstmate attribution

Upstream: https://github.com/kunchenguid/firstmate

Revision: `a24f4cb873d87295dddbc521599c21ea86d6dc00`

Copyright (c) 2026 Kun Chen. MIT license retained in `LICENSE` beside this file.

`apps/server/src/ssh-runtime/transport.ts` adapts the SSH argument policy and
unknown-completion semantics from `bin/fm-on.sh`. Mimir adds strict host-key and
batch operation, bounded structured stdin, response framing, and its own tests.
The native backend scripts listed below are bundled and executed through the fixed bridge. Upstream agent instructions are not installed or executed.

Firstmate's harness/backend separation, stable terminal identity, and remote
reconciliation behavior also informed the implementation plan. This attribution
does not imply endorsement, affiliation, or equivalent compatibility coverage.

## Native terminal backends

`bin/backends/{zellij,cmux,orca}.sh`, `bin/fm-backend-hometag-lib.sh`, and
`bin/fm-composer-lib.sh` are copied unmodified from the pinned revision above.
They retain upstream copyright and the MIT license in this directory.
`bridge.sh` is an original Mimir wrapper using their fixed operation contracts.
The factory does not claim authorship of these backend implementations.
Our Orca mode creates a terminal in an explicitly selected existing Orca
worktree; Mimir remains responsible for the actual task checkout, and no
upstream Orca worktree removal function is invoked.

## Lifecycle translation

`apps/server/src/terminal-runtime/harness-hooks.ts` adapts the lifecycle event contracts from `bin/fm-spawn.sh` at the pinned revision into session-scoped observation adapters for Gemini, OpenCode, Pi and OMP, plus Codex notifications. It retains this MIT attribution; generated adapters neither grant permissions nor mark delivery complete.

`apps/server/src/terminal-runtime/transcripts.ts` reimplements the Cursor and Muse
session-log contracts documented in `bin/fm-busy-lib.sh` at the same revision.
It uses structured JSON parsing, bounded files, exact workspace matching, prior-session
exclusion and lifecycle fingerprints to avoid reusing idle evidence after new input.
The upstream live-verification claims are not claims of local vendor acceptance.
