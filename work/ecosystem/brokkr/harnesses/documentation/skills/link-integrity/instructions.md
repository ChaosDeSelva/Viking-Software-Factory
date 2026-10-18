# Link integrity

A broken link is a dead end. Relative links and anchors must resolve.

## Always

- Use relative links for files in the repository and verify the target exists.
- Verify heading anchors after renaming a heading; update every inbound link.
- Link to stable, versioned or permanent targets rather than line numbers on a moving branch.
- Run the repository's link check script when one exists.

## Never

- Never leave a link to a deleted or renamed file.
- Never use bare absolute local paths in docs.
- Never ignore link check failures with a blanket allowlist.

## Verify

- `pnpm run docs:links` exits 0 when the script exists.
- Each changed link target was opened or checked to exist.
