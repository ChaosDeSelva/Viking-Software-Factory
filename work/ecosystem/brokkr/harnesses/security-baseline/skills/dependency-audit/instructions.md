# Dependency audit

Audit what the lockfile pins, not what package.json allows.

## Always

- Run `pnpm audit --json` when `pnpm-lock.yaml` exists, `npm audit --json` when `package-lock.json` exists.
- Fail on high and critical advisories in production dependencies; report moderate and dev-only ones as `heuristic`.
- Prefer upgrading to a patched version; record the advisory ID for any accepted exception with an expiry.
- Review new dependencies for maintenance, license (Apache-2.0 compatible) and install scripts.

## Never

- Never run `audit fix --force` or bump major versions automatically.
- Never install or update packages without approval.
- Never treat an unavailable audit (offline, registry error) as a pass.

## Verify

- The audit exits 0, or every remaining advisory is listed with an approved exception.
- The lockfile diff contains only intended changes.
