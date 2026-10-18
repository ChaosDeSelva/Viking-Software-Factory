# H02: Typed adapter interface and fake runtime

Status: **done**
Phase and gate: Phase 0 / G0
Owning task(s): T3, T5
Last updated: 2026-10-14 (T15d)

## Done so far
Status refresh 2026-10-14 (from the ledger): T3, T5.

`RuntimeAdapter` interface and runtime schemas in `packages/protocol/src/runtime.ts`; `packages/fake-runtime` with recorded fixtures.

## Remaining
None for this epic.

## Acceptance tests
* [ ] Type equality tests between Zod schemas and TypeScript types.
* [ ] FakeRuntime and fixture replay pass the same adapter tests.

## Commits (local repository, no remote)
9eb861b, 86f8d22, fb05c6f
