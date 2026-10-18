# Secret scan

Secrets in a repository are compromised secrets. Distinguish confirmed from suspected.

## Always

- Run the bundled scanner (`scan.mjs --kind secrets`) over the working tree.
- Treat a match on a provider-specific format (AWS, GitHub, Slack, Stripe, Google, private key block) as `finding` and fail.
- Treat generic assignments and JWT-shaped strings as `heuristic`: report, review, do not fail.
- Rotate any real secret that was committed; removing it from history is not enough.
- Load secrets from environment or a secret manager and commit only `.env.example` with placeholders.

## Never

- Never print or store the matched secret value in reports; show file, line and rule only.
- Never silence a finding by editing the pattern list or adding a broad ignore.
- Never mark a finding as a false positive without a recorded reason.

## Verify

- The scan reports zero `finding` entries.
- Every `heuristic` entry has a reviewed disposition in the task notes.
