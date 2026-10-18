# Input validation

Everything from outside the process is untrusted: bodies, query, headers, files, env, queue messages.

## Always

- Parse input with a schema at the boundary and use only the parsed, typed result afterwards.
- Reject unknown fields on write requests; set max lengths, ranges, array sizes and body size.
- Use parameterized queries and typed query builders for all database access.
- Validate and normalize file names and paths; resolve and check against an allowed base directory.
- Parse CLI arguments with `util.parseArgs` and validate them like any input; import built-ins with the `node:` prefix; where file or process access is sensitive, run with the Node permission model (`--permission`).
- Validate environment configuration once at startup and fail fast.

## Never

- Never build SQL, shell commands, regexes or HTML from raw input by concatenation.
- Never trust client-supplied IDs, roles, prices or flags.
- Never use a validator's pass as authorization.

## Verify

- Tests send missing, malformed, oversized and extra-field input and expect 4xx with no side effects.
- A grep of the diff shows no raw input reaching queries, commands or file paths.
