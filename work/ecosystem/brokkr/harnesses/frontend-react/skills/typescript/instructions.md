# TypeScript

Write TypeScript the compiler can actually check.

## Always

- Keep `strict` on and fix the type error instead of weakening compiler options.
- Use `unknown` at trust boundaries and narrow it; validate external input with a schema and derive the type.
- Model states with discriminated unions rather than optional-field combinations.
- Use `satisfies` to check an object against a type without widening it; enable `verbatimModuleSyntax` and use `import type` for type-only imports.
- Annotate exported function signatures; let inference handle locals.
- Handle the `undefined` case under `noUncheckedIndexedAccess`.

## Never

- Never use `any` in new code; never use non-null `!` to silence an error.
- Never add `@ts-ignore`; use `@ts-expect-error` only with a comment explaining why.
- Never cast through `as unknown as T` to bypass a mismatch between real shapes.
- Never use enums or namespaces where a union of literals or `as const` object works.

## Verify

- `tsc --noEmit` reports zero errors in the touched packages.
- Lint reports no new `no-explicit-any` or unsafe-assignment findings.
