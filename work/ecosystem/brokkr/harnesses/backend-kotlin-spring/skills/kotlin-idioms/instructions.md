# Kotlin idioms

Use the type system to make illegal states unrepresentable.

## Always

- Prefer `val`, immutable collections and `data class` for values.
- Model results and states with `sealed` types and exhaustive `when`.
- Handle nullability explicitly with `?.`, `?:` and `requireNotNull` with a message.
- Use structured concurrency and inject dispatchers; never launch in `GlobalScope`.

## Never

- Never use `!!` outside tests.
- Never block inside a coroutine with `runBlocking` in production code.
- Never expose mutable collections from public APIs.

## Verify

- The compiler reports no warnings in the touched modules.
- Tests cover nullable and sealed-state branches.
