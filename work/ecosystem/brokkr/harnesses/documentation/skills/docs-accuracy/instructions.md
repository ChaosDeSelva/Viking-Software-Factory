# Documentation accuracy

Docs that disagree with the code are bugs. Verify every claim against the source.

## Always

- Update docs in the same change as the behavior, flag, config key or command they describe.
- Check each documented command, option, path, default and environment variable against the code.
- Document one source of truth per fact and link to it elsewhere.
- State prerequisites, supported versions and platforms explicitly.
- Write for the reader's task: purpose, steps, expected result, troubleshooting.

## Never

- Never document planned or unimplemented behavior as if it exists.
- Never copy output or version numbers by hand when they can be generated.
- Never leave a renamed or removed feature mentioned in docs.

## Verify

- A grep for every renamed or removed identifier finds no stale mention in docs.
- Each changed claim has been checked against the code or by running it.
