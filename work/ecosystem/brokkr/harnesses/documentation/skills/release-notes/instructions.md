# Release notes

Release notes tell users what changed and what they must do.

## Always

- Group entries as Added, Changed, Fixed, Removed and Security, newest version first.
- Describe user-visible impact in one sentence, with the issue or commit reference.
- Call out breaking changes first with the exact migration steps.
- Match the version and date to the actual tag and to `package.json`.
- Derive entries from the real diff and commit history.

## Never

- Never list internal refactors as features or omit a breaking change.
- Never use marketing language or unverifiable claims.
- Never edit past release entries except to correct errors.

## Verify

- Every entry maps to a commit or merged change in the release range.
- Each breaking change has a documented migration step.
